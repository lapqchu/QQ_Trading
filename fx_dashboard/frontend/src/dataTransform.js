/**
 * Transform backend snapshot into dashboard data structures.
 *
 * KEY DESIGN: The backend now sends SWAP POINTS directly (from traded RICs
 * like TWD1MNDF=), NOT outright prices. This means:
 *   - tenor.T.bid/ask/mid = swap points bid/ask/mid (market-traded widths)
 *   - outright = spot + points / pipFactor
 *   - All swap point displays use the data directly (no more deriving from outrights)
 *
 * Roll-down: for tenor T, roll-down = value(T) - value(T-1period).
 * E.g. roll-down on 2Mx3M = IY(2Mx3M) - IY(1Mx2M).
 */
import { mcI, mid, implYld, fwdFwdIy } from "./calc.js";
import { buildIMMDates, buildTenorDates, computeSpotDate, bizBefore, dateFromSpot, daysBtwn, fD } from "./dates.js";

/**
 * Convert backend snapshot JSON → v2 data structures.
 * Backend sends swap points in tenor.T.bid/ask fields.
 */
function snapToRaw(snap) {
  const RAW = {};
  const PF = snap.pipFactor || 1e3;

  // Spot
  const sT = snap.spot?.T || {}, sT1 = snap.spot?.T1 || {};
  RAW.spot = {
    T: { b: sT.bid, a: sT.ask, m: sT.mid ?? mid(sT.bid, sT.ask) },
    T1: { b: sT1.bid, a: sT1.ask, m: sT1.mid ?? mid(sT1.bid, sT1.ask) },
  };

  // NDF 1M outright (ticks frequently — used to derive implied spot for NDF pairs)
  RAW.ndf1mOut = null;
  if (snap.ndf1mOutright) {
    const oT = snap.ndf1mOutright.T || {}, oT1 = snap.ndf1mOutright.T1 || {};
    RAW.ndf1mOut = {
      ric: snap.ndf1mOutright.ric,
      T: { b: oT.bid, a: oT.ask, m: oT.mid ?? mid(oT.bid, oT.ask) },
      T1: { b: oT1.bid, a: oT1.ask, m: oT1.mid ?? mid(oT1.bid, oT1.ask) },
    };
  }

  // Swap points per tenor (PRIMARY data from market-traded RICs)
  RAW.pts = {};
  for (const m of snap.tenorsM) {
    const t = snap.tenors[m] || snap.tenors[String(m)] || {};
    const tT = t.T || {}, tT1 = t.T1 || {};
    const pBid = tT.bid ?? tT.last;
    const pAsk = tT.ask ?? tT.last;
    const pMid = tT.mid ?? mid(pBid, pAsk);
    const pBid1 = tT1.bid ?? tT1.last;
    const pAsk1 = tT1.ask ?? tT1.last;
    const pMid1 = tT1.mid ?? mid(pBid1, pAsk1);

    RAW.pts[m] = {
      T: { b: pBid, m: pMid, a: pAsk },
      T1: { b: pBid1, m: pMid1, a: pAsk1 },
      days: { T: t.days || m * 30, T1: t.days || m * 30 },
      hasData: t.hasData !== false,
    };
  }

  // SOFR
  const RAW_SOFR = {};
  for (const [m, s] of Object.entries(snap.sofr || {})) {
    const sT2 = s.T || {}, sT12 = s.T1 || {};
    RAW_SOFR[+m] = {
      T: sT2.mid ?? sT2.last ?? sT2.bid ?? null,
      T1: sT12.mid ?? sT12.last ?? sT12.bid ?? null,
    };
  }

  // Funding (deliverables: ON/TN/SN)
  RAW.funding = {};
  for (const [tenor, data] of Object.entries(snap.funding || {})) {
    const fT = data.T || {}, fT1 = data.T1 || {};
    RAW.funding[tenor] = {
      T: { b: fT.bid, a: fT.ask, m: fT.mid ?? mid(fT.bid, fT.ask) },
      T1: { b: fT1.bid, a: fT1.ask, m: fT1.mid ?? mid(fT1.bid, fT1.ask) },
    };
  }

  return { RAW, RAW_SOFR };
}


// Map IPA tenor string → month number for lookup
function ipaTenorToMonth(t) {
  if (!t) return null;
  const m = t.match(/^(\d+)(M|Y|W)$/i);
  if (!m) return null;
  const n = parseInt(m[1]), u = m[2].toUpperCase();
  if (u === 'Y') return n * 12;
  if (u === 'W') return n / 4;
  return n;
}

// Build broker swap points RIC for a given ccy/kind/tenor/contributor
function brokerSwapRic(ccy, kind, m, contrib) {
  const tenor = m === 0 ? "" : m < 12 ? `${m}M` : m === 12 ? "1Y" : m === 18 ? "18M" : m === 24 ? "2Y" : `${m}M`;
  if (kind === "NDF") return `${ccy}${tenor}NDF=${contrib}`;
  return `${ccy}${tenor}=${contrib}`;
}

// Main build function
export function buildAllData(snap, liveQuotes = {}, sources = ["DEFAULT"]) {
  if (!snap) return null;
  const { RAW, RAW_SOFR } = snapToRaw(snap);
  const PF = snap.pipFactor || 1e3;
  const dp = snap.outrightDp || 3;
  const pipDp = snap.pipDp || 1;
  const ptsInOutright = snap.ptsInOutright || false; // LSEG gives pts as outright diff
  const knownM = snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  const maxT = snap.maxDisplayM || knownM[knownM.length - 1] || 24;
  const ccyCode = snap.ccy;
  const ccyKind = snap.kind;

  // IPA data: Workspace-computed values for non-anchor (and anchor) tenors
  // Keys are tenor strings ("1W","2W","3W","4M","1Y",...), values have fwdPoints, impliedYield, days, fixDate, valueDate
  const IPA = {};
  if (snap.ipa) {
    for (const [tenorStr, data] of Object.entries(snap.ipa)) {
      const m = ipaTenorToMonth(tenorStr);
      if (m != null && data) IPA[m] = data;
    }
  }
  const sofrM = [1, 2, 3, 6, 9, 12, 18, 24].filter(m => m <= Math.max(maxT, 24));

  const SPOT_DATE = computeSpotDate();
  const IMM_DATES = buildIMMDates(SPOT_DATE);
  const TENOR_DATES = buildTenorDates(SPOT_DATE);

  // Spot
  const sMT = RAW.spot.T.m || 0;
  const sBT = RAW.spot.T.b;
  const sAT = RAW.spot.T.a;
  const sMT1 = RAW.spot.T1.m || 0;
  const sBT1 = RAW.spot.T1.b;
  const sAT1 = RAW.spot.T1.a;

  // NDF: derive implied spot from 1M outright - 1M swap points / PF
  // The 1M outright ticks frequently on LSEG for NDF, making this the responsive anchor.
  const isNDF = snap.kind === "NDF";
  const ndf1mOutRic = RAW.ndf1mOut?.ric;

  function deriveNdfSpot(dk) {
    // Get 1M outright (live or snapshot)
    let out1m;
    if (dk === "T") {
      const lqOut = ndf1mOutRic ? liveQuotes[ndf1mOutRic] : null;
      out1m = lqOut
        ? { b: lqOut.bid, a: lqOut.ask, m: lqOut.mid ?? mid(lqOut.bid, lqOut.ask) }
        : RAW.ndf1mOut?.T;
    } else {
      out1m = RAW.ndf1mOut?.T1;
    }
    if (!out1m?.m) return null;

    // Get 1M swap points (live or snapshot)
    const pts1m = getPts(1, dk);
    const ptsM = pts1m?.m ?? 0;

    // spot = 1M_outright - 1M_swap_points
    // If ptsInOutright: pts are outright diffs, subtract directly
    // If not: pts are in pip units, divide by PF first
    const ptsDiff = ptsInOutright ? ptsM : ptsM / PF;
    const derivedM = out1m.m - ptsDiff;
    const ptsDiffA = ptsInOutright ? (pts1m.a ?? 0) : (pts1m.a ?? 0) / PF;
    const ptsDiffB = ptsInOutright ? (pts1m.b ?? 0) : (pts1m.b ?? 0) / PF;
    const derivedB = out1m.b != null ? out1m.b - ptsDiffA : derivedM;
    const derivedA = out1m.a != null ? out1m.a - ptsDiffB : derivedM;
    return { b: derivedB, m: derivedM, a: derivedA };
  }

  // Live quote override for spot
  function getLiveSpot(dk) {
    if (dk === "T") {
      // For NDF: derive spot from 1M outright (ticks frequently)
      if (isNDF && RAW.ndf1mOut) {
        const derived = deriveNdfSpot("T");
        if (derived) return derived;
      }
      // Fallback: use direct spot RIC
      const spotRic = snap.spot?.ric;
      const lq = liveQuotes[spotRic];
      if (lq) return { b: lq.bid ?? sBT, a: lq.ask ?? sAT, m: lq.mid ?? mid(lq.bid ?? sBT, lq.ask ?? sAT) };
      return RAW.spot.T;
    }
    // T1: for NDF use derived spot too
    if (isNDF && RAW.ndf1mOut) {
      const derived = deriveNdfSpot("T1");
      if (derived) return derived;
    }
    return RAW.spot.T1;
  }

  // Broker data from snapshot: { contrib: { tenor_m: { ric, T: {bid,ask,...}, T1: {...} } } }
  const BROKERS = snap.brokers || {};

  // Get swap points for a tenor, with live override + multi-source averaging
  function getPts(m, dk) {
    const raw = RAW.pts[m];
    if (!raw) return { b: null, m: null, a: null };
    const base = raw[dk] || { b: null, m: null, a: null };
    if (dk !== "T") return base;

    // Collect values from all selected sources
    const vals = []; // each: { b, m, a }

    for (const src of sources) {
      if (src === "DEFAULT") {
        // Composite RIC (live or snapshot)
        const tenorData = snap.tenors?.[m] || snap.tenors?.[String(m)];
        const ric = tenorData?.ric;
        const lq = liveQuotes[ric];
        if (lq && (lq.bid != null || lq.ask != null)) {
          vals.push({ b: lq.bid, m: lq.mid ?? mid(lq.bid, lq.ask), a: lq.ask });
        } else if (base.b != null || base.a != null) {
          vals.push(base);
        }
      } else {
        // Broker source: check liveQuotes first, then snapshot brokers
        const bRic = brokerSwapRic(ccyCode, ccyKind, m, src);
        const lq = liveQuotes[bRic];
        if (lq && (lq.bid != null || lq.ask != null)) {
          vals.push({ b: lq.bid, m: lq.mid ?? mid(lq.bid, lq.ask), a: lq.ask });
        } else {
          // Fallback to snapshot broker data
          const bSnap = BROKERS[src]?.[m]?.T || BROKERS[src]?.[String(m)]?.T;
          if (bSnap && (bSnap.bid != null || bSnap.ask != null)) {
            vals.push({ b: bSnap.bid, m: bSnap.mid ?? mid(bSnap.bid, bSnap.ask), a: bSnap.ask });
          }
        }
      }
    }

    if (vals.length === 0) return base;
    if (vals.length === 1) return vals[0];

    // Average across sources
    const avg = (arr) => {
      const valid = arr.filter(v => v != null);
      return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    };
    return {
      b: avg(vals.map(v => v.b)),
      m: avg(vals.map(v => v.m)),
      a: avg(vals.map(v => v.a)),
    };
  }

  // Build anchor arrays for interpolation (using swap points)
  function anchorPts(dk) {
    const mo = [0], pM = [0], pB = [0], pA = [0], days = [0];
    knownM.forEach(m => {
      const p = getPts(m, dk);
      if (p.b == null && p.a == null && p.m == null) return;
      mo.push(m);
      days.push(RAW.pts[m]?.days?.[dk] || m * 30);
      pM.push(p.m); pB.push(p.b); pA.push(p.a);
    });
    return { mo, days, pM, pB, pA };
  }

  function anchorSOFR(dk) {
    const mo = [], va = [];
    sofrM.forEach(m => {
      const v = RAW_SOFR[m]?.[dk];
      if (v != null) { mo.push(m); va.push(v); }
    });
    return { mo, va };
  }

  const ptT = anchorPts("T"), ptT1 = anchorPts("T1");
  const sT = anchorSOFR("T"), sT1 = anchorSOFR("T1");

  // Interpolators for swap points
  const iPtMT = mcI(ptT.days, ptT.pM), iPtBT = mcI(ptT.days, ptT.pB), iPtAT = mcI(ptT.days, ptT.pA);
  const iPtMT1 = mcI(ptT1.days, ptT1.pM), iPtBT1 = mcI(ptT1.days, ptT1.pB), iPtAT1 = mcI(ptT1.days, ptT1.pA);
  const iDT = mcI(ptT.mo, ptT.days), iDT1 = mcI(ptT1.mo, ptT1.days);
  const iST = mcI(sT.mo, sT.va), iST1 = mcI(sT1.mo, sT1.va);

  function getRow(month, daysOvr, label, immVD) {
    const isK = (month === 0 || knownM.includes(month)) && !daysOvr;
    const ipaD = IPA[month]; // Workspace IPA data for this tenor (if available)

    // Days: prefer IPA days if available, otherwise interpolate
    const dT = daysOvr || (ipaD?.days != null ? Math.round(ipaD.days) : Math.round(iDT(month)));
    const dT1 = daysOvr ? Math.round(iDT1(month) + (daysOvr - iDT(month))) : Math.round(iDT1(month));

    // Data source tracking
    let dataSource = month === 0 ? "spot" : isK ? "RIC" : (ipaD ? "IPA" : "interp");

    let spB, spM, spA, spB1, spM1, spA1;
    if (month === 0) {
      spB = 0; spM = 0; spA = 0; spB1 = 0; spM1 = 0; spA1 = 0;
    } else if (isK) {
      // Anchor tenor: direct RIC data (primary source)
      const p = getPts(month, "T"), p1 = getPts(month, "T1");
      spB = p.b; spM = p.m; spA = p.a;
      spB1 = p1.b; spM1 = p1.m; spA1 = p1.a;
    } else if (ipaD && ipaD.fwdPoints != null) {
      // Non-anchor: Workspace IPA (preferred over our interpolation)
      // IPA returns mid forward points. We use it as mid; bid/ask from interpolation for width.
      const ipaM = ipaD.fwdPoints;
      // Get interpolated bid/ask for spread width, but center on IPA mid
      const interpM = iPtMT(dT);
      const interpB = iPtBT(dT);
      const interpA = iPtAT(dT);
      if (interpM != null && interpB != null && interpA != null) {
        // Shift interpolated curve to IPA mid, keeping bid/ask width
        const shift = ipaM - interpM;
        spB = interpB + shift; spM = ipaM; spA = interpA + shift;
      } else {
        // No interpolation available — use IPA mid for all three
        spB = ipaM; spM = ipaM; spA = ipaM;
      }
      // T1: use interpolation (IPA is T only)
      spM1 = iPtMT1(dT1); spB1 = iPtBT1(dT1); spA1 = iPtAT1(dT1);
    } else {
      // Fallback: our mcI interpolation (last resort)
      spM = iPtMT(dT); spB = iPtBT(dT); spA = iPtAT(dT);
      spM1 = iPtMT1(dT1); spB1 = iPtBT1(dT1); spA1 = iPtAT1(dT1);
    }

    const spot = getLiveSpot("T");
    const spot1 = getLiveSpot("T1");

    // For NDF 1M: use direct outright from LSEG (it ticks frequently)
    let bT, aT, mT, bT1, aT1, mT1;
    if (isNDF && month === 1 && RAW.ndf1mOut) {
      // 1M outright = direct from LSEG TWD1MNDFOR= (not computed from spot+pts)
      const lqOut = ndf1mOutRic ? liveQuotes[ndf1mOutRic] : null;
      const out1 = lqOut
        ? { b: lqOut.bid, a: lqOut.ask, m: lqOut.mid ?? mid(lqOut.bid, lqOut.ask) }
        : RAW.ndf1mOut.T;
      const out1_1 = RAW.ndf1mOut.T1;
      bT = out1?.b ?? out1?.m; aT = out1?.a ?? out1?.m; mT = out1?.m;
      bT1 = out1_1?.b ?? out1_1?.m; aT1 = out1_1?.a ?? out1_1?.m; mT1 = out1_1?.m;
    } else if (month === 0) {
      bT = spot.b; aT = spot.a; mT = spot.m;
      bT1 = spot1.b; aT1 = spot1.a; mT1 = spot1.m;
    } else if (ptsInOutright) {
      // LSEG gives swap points as outright difference — add directly (no PF division)
      bT = spot.m != null && spB != null ? spot.m + spB : null;
      aT = spot.m != null && spA != null ? spot.m + spA : null;
      mT = spot.m != null && spM != null ? spot.m + spM : null;
      bT1 = spot1.m != null && spB1 != null ? spot1.m + spB1 : null;
      aT1 = spot1.m != null && spA1 != null ? spot1.m + spA1 : null;
      mT1 = spot1.m != null && spM1 != null ? spot1.m + spM1 : null;
    } else {
      // LSEG gives swap points in pip units — divide by PF to get outright diff
      bT = spot.m != null && spB != null ? spot.m + spB / PF : null;
      aT = spot.m != null && spA != null ? spot.m + spA / PF : null;
      mT = spot.m != null && spM != null ? spot.m + spM / PF : null;
      bT1 = spot1.m != null && spB1 != null ? spot1.m + spB1 / PF : null;
      aT1 = spot1.m != null && spA1 != null ? spot1.m + spA1 / PF : null;
      mT1 = spot1.m != null && spM1 != null ? spot1.m + spM1 / PF : null;
    }

    const sofTRaw = month > 0 && sT.mo.length > 0 ? iST(Math.min(month, 24)) : null;
    const sofT1Raw = month > 0 && sT1.mo.length > 0 ? iST1(Math.min(month, 24)) : null;
    const sofT = sofTRaw != null && isFinite(sofTRaw) ? sofTRaw : (month === 0 ? 0 : null);
    const sofT1 = sofT1Raw != null && isFinite(sofT1Raw) ? sofT1Raw : (month === 0 ? 0 : null);

    // Implied yield: prefer IPA if available, otherwise compute locally
    let iyB, iyM, iyA, iyB1, iyM1, iyA1;
    if (ipaD && ipaD.impliedYield != null && !isK && month > 0) {
      // IPA implied yield is the authoritative mid value
      iyM = ipaD.impliedYield;
      // Compute bid/ask IY locally (IPA only gives mid)
      iyB = dT > 0 ? implYld(bT, sAT, sofT, dT) : null;
      iyA = dT > 0 ? implYld(aT, sBT, sofT, dT) : null;
    } else {
      iyB = dT > 0 ? implYld(bT, sAT, sofT, dT) : null;
      iyM = dT > 0 ? implYld(mT, sMT, sofT, dT) : null;
      iyA = dT > 0 ? implYld(aT, sBT, sofT, dT) : null;
    }
    iyB1 = dT1 > 0 ? implYld(bT1, sAT1, sofT1, dT1) : null;
    iyM1 = dT1 > 0 ? implYld(mT1, sMT1, sofT1, dT1) : null;
    iyA1 = dT1 > 0 ? implYld(aT1, sBT1, sofT1, dT1) : null;

    const basisT = iyM != null && sofT != null ? iyM - sofT : null;
    const basisT1 = iyM1 != null && sofT1 != null ? iyM1 - sofT1 : null;
    const iyBpD = iyM != null && dT > 0 ? iyM / 360 * 100 : null;

    // Dates: prefer IPA dates (Workspace holiday calendars), fallback to local calc
    const td = TENOR_DATES[Math.round(month)] || {};
    const ipaValDate = ipaD?.valueDate ? new Date(ipaD.valueDate) : null;
    const ipaFixDate = ipaD?.fixDate ? new Date(ipaD.fixDate) : null;
    const valDate = immVD || ipaValDate || td.valDate || (daysOvr ? dateFromSpot(SPOT_DATE, daysOvr) : null);
    const fixDate = ipaFixDate || (valDate ? bizBefore(valDate, 2) : td.fixDate);

    // Convert swap points to pip display units if LSEG gives outright diffs
    const dpB = ptsInOutright && spB != null ? spB * PF : spB;
    const dpM = ptsInOutright && spM != null ? spM * PF : spM;
    const dpA = ptsInOutright && spA != null ? spA * PF : spA;
    const dpB1 = ptsInOutright && spB1 != null ? spB1 * PF : spB1;
    const dpM1 = ptsInOutright && spM1 != null ? spM1 * PF : spM1;
    const dpA1 = ptsInOutright && spA1 != null ? spA1 * PF : spA1;

    return {
      tenor: label || (month === 0 ? "Spot" : month <= 12 ? `${month}M` : month === 24 ? "2Y" : `${month}M`),
      month, dT, dT1, dataSource,
      bT, aT, mT, bT1, aT1, mT1,
      spB: dpB, spM: dpM, spA: dpA, spB1: dpB1, spM1: dpM1, spA1: dpA1,
      ptsPerDay: dT > 0 && dpM != null ? dpM / dT : null,
      sofT, sofT1, iyB, iyM, iyA, iyB1, iyM1, iyA1,
      basisT, basisT1, iyBpD,
      interp: !isK && month !== 0,
      valDate, fixDate,
    };
  }

  const weekM = [0.25, 0.5, 0.75];
  const weekLabels = ["1W", "2W", "3W"];
  const rows = [getRow(0)];
  for (let w = 0; w < weekM.length; w++) {
    const wr = getRow(weekM[w], Math.round(weekM[w] * 30), weekLabels[w]);
    wr.interp = true;
    wr.isWeekly = true;
    rows.push(wr);
  }
  for (let m = 1; m <= maxT; m++) rows.push(getRow(m));

  const immR = IMM_DATES.filter(im => im.days <= maxT * 31)
    .map(im => getRow(im.days / 30.44, im.days, im.label, im.valDate));

  // Fwd-fwd chain + roll-down
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = i > 0 ? rows[i - 1] : null;
    // Forward-forward points: null if either leg has null points
    r.ffB = i === 0 ? 0 : (r.spB != null && p?.spA != null ? r.spB - p.spA : null);
    r.ffM = i === 0 ? 0 : (r.spM != null && p?.spM != null ? r.spM - p.spM : null);
    r.ffA = i === 0 ? 0 : (r.spA != null && p?.spB != null ? r.spA - p.spB : null);
    r.ffB1 = i === 0 ? 0 : (r.spB1 != null && p?.spA1 != null ? r.spB1 - p.spA1 : null);
    r.ffM1 = i === 0 ? 0 : (r.spM1 != null && p?.spM1 != null ? r.spM1 - p.spM1 : null);
    r.ffA1 = i === 0 ? 0 : (r.spA1 != null && p?.spB1 != null ? r.spA1 - p.spB1 : null);
    r.ffIyB = p ? fwdFwdIy(p.iyA, p.dT, r.iyB, r.dT) : null;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyA = p ? fwdFwdIy(p.iyB, p.dT, r.iyA, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    const fwdD = p ? r.dT - p.dT : 0;
    // Forward SOFR: null if either leg's SOFR is null
    r.ffSofr = fwdD > 0 && r.sofT != null && p?.sofT != null ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + p.sofT / 100 * p.dT / 360) - 1) * 360 / fwdD * 100 : null;
    r.ffBasis = r.ffIyM != null && r.ffSofr != null ? r.ffIyM - r.ffSofr : null;
    r.ffIyBpD = r.ffIyM != null && fwdD > 0 ? r.ffIyM / 360 * 100 : null;
    // D/D changes: null if either day's value is null
    r.pipChg = r.spM != null && r.spM1 != null ? r.spM - r.spM1 : null;
    r.ffChg = r.ffM != null && r.ffM1 != null ? r.ffM - r.ffM1 : null;
    r.iyChg = r.iyM != null && r.iyM1 != null ? r.iyM - r.iyM1 : null;
    r.sofChg = r.sofT != null && r.sofT1 != null ? r.sofT - r.sofT1 : null;
    r.basChg = r.basisT != null && r.basisT1 != null ? r.basisT - r.basisT1 : null;
    r.ffIyChg = r.ffIyM != null && r.ffIyM1 != null ? r.ffIyM - r.ffIyM1 : null;
    // Carry = fwd-fwd points for the marginal period (what you earn holding)
    //   carryP (pips): the fwd-fwd swap points for period [i-1, i]
    //   carryY (yield): the fwd-fwd implied yield for period [i-1, i]
    r.carryP = r.ffM;
    r.carryY = r.ffIyM;
    // Roll-down = change in carry as position ages one period (curve convexity benefit)
    //   rollP (pips): carry[i] - carry[i-1]  (how fwd-fwd changes along the curve)
    //   rollY (yield): same in yield terms
    r.rollP = i >= 2 && r.ffM != null && p?.ffM != null ? r.ffM - p.ffM : (i === 1 ? r.ffM : null);
    r.rollY = i >= 2 && r.ffIyM != null && p?.ffIyM != null ? r.ffIyM - p.ffIyM : (i === 1 ? r.ffIyM : null);
  }

  // IMM D/D
  for (let i = 0; i < immR.length; i++) {
    const r = immR[i], p = i > 0 ? immR[i - 1] : null;
    r.pipChg = r.spM != null && r.spM1 != null ? r.spM - r.spM1 : null;
    r.iyChg = r.iyM != null && r.iyM1 != null ? r.iyM - r.iyM1 : null;
    r.sofChg = r.sofT != null && r.sofT1 != null ? r.sofT - r.sofT1 : null;
    r.basChg = r.basisT != null && r.basisT1 != null ? r.basisT - r.basisT1 : null;
    r.ptsPerDay = r.dT > 0 && r.spM != null ? r.spM / r.dT : null;
    r.ffB = i === 0 ? r.spB : (r.spB != null && p?.spA != null ? r.spB - p.spA : null);
    r.ffM = i === 0 ? r.spM : (r.spM != null && p?.spM != null ? r.spM - p.spM : null);
    r.ffA = i === 0 ? r.spA : (r.spA != null && p?.spB != null ? r.spA - p.spB : null);
    r.ffM1 = i === 0 ? r.spM1 : (r.spM1 != null && p?.spM1 != null ? r.spM1 - p.spM1 : null);
    r.ffChg = r.ffM != null && r.ffM1 != null ? r.ffM - r.ffM1 : null;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    r.ffIyChg = r.ffIyM != null && r.ffIyM1 != null ? r.ffIyM - r.ffIyM1 : null;
    const fwdD = p ? r.dT - p.dT : r.dT;
    r.ffSofr = fwdD > 0 && r.sofT != null && (p ? p.sofT != null : true) ? (p ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + p.sofT / 100 * p.dT / 360) - 1) * 360 / fwdD * 100 : r.sofT) : null;
    r.ffBasis = r.ffIyM != null && r.ffSofr != null ? r.ffIyM - r.ffSofr : null;
  }

  // Spreads — find rows by month, NOT by index
  function mkSpr(nrM, frM, label) {
    const nr = rows.find(r => r.month === nrM);
    const fr = rows.find(r => r.month === frM);
    if (!nr || !fr) return null;
    // Null-safe: if either leg's points are null, spread is null (not zero)
    const haveT = fr.spB != null && fr.spM != null && fr.spA != null && nr.spA != null && nr.spM != null && nr.spB != null;
    const haveT1 = fr.spB1 != null && fr.spM1 != null && fr.spA1 != null && nr.spA1 != null && nr.spM1 != null && nr.spB1 != null;
    const pB = haveT ? fr.spB - nr.spA : null, pM = haveT ? fr.spM - nr.spM : null, pA = haveT ? fr.spA - nr.spB : null;
    const pB1 = haveT1 ? fr.spB1 - nr.spA1 : null, pM1 = haveT1 ? fr.spM1 - nr.spM1 : null, pA1 = haveT1 ? fr.spA1 - nr.spB1 : null;
    const ds = fr.dT - nr.dT;
    const fIyB = fwdFwdIy(nr.iyA, nr.dT, fr.iyB, fr.dT);
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    const fIyA = fwdFwdIy(nr.iyB, nr.dT, fr.iyA, fr.dT);
    const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    // Null-safe: if SOFR is null for either leg, forward SOFR is null
    const haveSof = ds > 0 && fr.sofT != null && nr.sofT != null;
    const haveSof1 = ds > 0 && fr.sofT1 != null && nr.sofT1 != null;
    const fSof = haveSof ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + nr.sofT / 100 * nr.dT / 360) - 1) * 360 / ds * 100 : null;
    const fSof1 = haveSof1 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + nr.sofT1 / 100 * nr.dT1 / 360) - 1) * 360 / ds * 100 : null;
    const bas = fIy != null && fSof != null ? fIy - fSof : null;
    return {
      label, nrM, frM, pB, pM, pA, pB1, pM1, pA1, chg: pM != null && pM1 != null ? pM - pM1 : null, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFxD: nr.fixDate, frFxD: fr.fixDate,
      nrDT: nr.dT, frDT: fr.dT,
      fIyB, fIy, fIyA, fIy1,
      iyChg: fIy != null && fIy1 != null ? fIy - fIy1 : null,
      fSof, fSof1, sofChg: fSof != null && fSof1 != null ? fSof - fSof1 : null,
      bas, basChg: bas != null && fIy1 != null && fSof1 != null ? bas - (fIy1 - fSof1) : null,
      ppd: ds > 0 && pM != null ? pM / ds : null,
      iyBpD: fIy != null ? fIy / 360 * 100 : null,
    };
  }

  let anchors, qFF, spSpr;
  if (snap.spreadPack === "NDF") {
    const anchorDefs = [[1,2,"1Mx2M"],[1,3,"1Mx3M"],[1,6,"1Mx6M"],[1,9,"1Mx9M"],[1,12,"1Mx12M"],[12,18,"12Mx18M"],[12,24,"12Mx2Y"]];
    anchors = anchorDefs.filter(([n,f]) => f <= maxT && n <= maxT).map(([n,f,l]) => mkSpr(n,f,l)).filter(Boolean);
    qFF = [];
    for (let n = 3; n <= 21; n += 3) {
      const f = n + 3;
      if (f <= maxT) { const s = mkSpr(n, f, `${n}M×${f <= 12 ? f+"M" : f===24 ? "2Y" : f+"M"}`); if (s) qFF.push(s); }
    }
  } else {
    // Deliverable: SPOT-START as anchor spreads
    anchors = [];
    for (const m of [1,2,3,6,9,12,18,24]) {
      if (m <= maxT) { const s = mkSpr(0, m, `SPx${m<=12?m+"M":"2Y"}`); if (s) anchors.push(s); }
    }
    qFF = [];
    const fwdFwdDefs = [[1,2,"1Mx2M"],[2,3,"2Mx3M"],[3,6,"3Mx6M"],[6,9,"6Mx9M"],[9,12,"9Mx12M"],[12,18,"12Mx18M"],[18,24,"18Mx24M"]];
    for (const [n,f,l] of fwdFwdDefs) { if (f <= maxT) { const s = mkSpr(n,f,l); if (s) qFF.push(s); } }
  }
  spSpr = [1,2,3,6,9,12,18,24].filter(f => f <= maxT).map(f => mkSpr(0, f, `SP×${f<=12?f+"M":"2Y"}`)).filter(Boolean);

  // IMM spreads — null-safe: missing data → null output
  const immSpr = [];
  for (let i = 0; i < immR.length - 1; i++) {
    const nr = immR[i], fr = immR[i+1];
    const haveImm = fr.spB != null && fr.spM != null && fr.spA != null && nr.spA != null && nr.spM != null && nr.spB != null;
    const pB = haveImm ? fr.spB - nr.spA : null, pM = haveImm ? fr.spM - nr.spM : null, pA = haveImm ? fr.spA - nr.spB : null;
    const haveImm1 = fr.spM1 != null && nr.spM1 != null;
    const pM1 = haveImm1 ? fr.spM1 - nr.spM1 : null;
    const ds = fr.dT - nr.dT;
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    const haveSofImm = ds > 0 && fr.sofT != null && nr.sofT != null;
    const fSof = haveSofImm ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + nr.sofT / 100 * nr.dT / 360) - 1) * 360 / ds * 100 : null;
    const haveSofImm1 = ds > 0 && fr.sofT1 != null && nr.sofT1 != null;
    const fSof1 = haveSofImm1 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + nr.sofT1 / 100 * nr.dT1 / 360) - 1) * 360 / ds * 100 : null;
    immSpr.push({
      label: `${nr.tenor.split(" ")[1] || nr.tenor}→${fr.tenor.split(" ")[1] || fr.tenor}`,
      nrM: nr.month, frM: fr.month,
      pB, pM, pA, pB1: null, pM1, pA1: null, chg: pM != null && pM1 != null ? pM - pM1 : null, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFxD: nr.fixDate, frFxD: fr.fixDate,
      nrDT: nr.dT, frDT: fr.dT,
      fIyB: null, fIy, fIyA: null, fIy1,
      iyChg: fIy != null && fIy1 != null ? fIy - fIy1 : null,
      fSof, fSof1, sofChg: fSof != null && fSof1 != null ? fSof - fSof1 : null,
      bas: fIy != null && fSof != null ? fIy - fSof : null, basChg: null,
      ppd: ds > 0 && pM != null ? pM / ds : null,
      iyBpD: fIy != null ? fIy / 360 * 100 : null,
    });
  }

  const funding = RAW.funding || {};
  const cfg = { pair: snap.pair, pipFactor: PF, dp, pipDp, kind: snap.kind, spreadPack: snap.spreadPack, ptsInOutright };
  return {
    rows, immR, anchors, qFF, spSpr, immSpr, funding,
    sMT, sMT1, sBT, sAT, cfg, ccy: snap.ccy, maxT,
    SPOT_DATE, TENOR_DATES,
    lastReloadTs: snap.lastReloadTs,
  };
}


// Custom tenor calculator
export function calcCustom(ad, nearM, farM, nearDate, farDate, ipaCustom) {
  const { rows, SPOT_DATE } = ad;
  let nM = nearM, fM = farM, nVD = null, fVD = null;
  if (nearDate) { nM = daysBtwn(SPOT_DATE, nearDate) / 30.44; nVD = nearDate; }
  if (farDate) { fM = daysBtwn(SPOT_DATE, farDate) / 30.44; fVD = farDate; }
  if (fM <= nM) return null;

  // --- IPA path: if Workspace IPA returned data for both legs, use it as primary ---
  if (ipaCustom && ipaCustom.near && ipaCustom.far) {
    const ipaN = ipaCustom.near, ipaF = ipaCustom.far;
    const nPts = ipaN.fwdPoints, fPts = ipaF.fwdPoints;
    const nDays = ipaN.days, fDays = ipaF.days;
    if (nPts != null && fPts != null && nDays != null && fDays != null) {
      const pM = fPts - nPts;
      // IPA only gives mid — estimate bid/ask from interpolated spread width
      const nrI = Math.floor(nM), frI = Math.floor(fM);
      const mT = ad.maxT || 24;
      const nrRow = nrI >= 0 && nrI <= mT ? rows.find(r => r.month === nrI) : null;
      const frRow = frI >= 0 && frI <= mT ? rows.find(r => r.month === frI) : null;
      const nrHalf = nrRow && nrRow.spB != null && nrRow.spA != null ? (nrRow.spA - nrRow.spB) / 2 : 0;
      const frHalf = frRow && frRow.spB != null && frRow.spA != null ? (frRow.spA - frRow.spB) / 2 : 0;
      // Spread bid = far_bid - near_ask; spread ask = far_ask - near_bid
      const pB = (fPts - frHalf) - (nPts + nrHalf);
      const pA = (fPts + frHalf) - (nPts - nrHalf);
      const ds = fDays - nDays;
      const nIy = ipaN.impliedYield, fIy_raw = ipaF.impliedYield;
      const fIy = nIy != null && fIy_raw != null ? fwdFwdIy(nIy, nDays, fIy_raw, fDays) : null;
      // Parse IPA dates (ISO strings → Date objects)
      const parseD = (s) => s ? new Date(s) : null;
      return {
        label: `${nearDate ? fD(nearDate) : `${Math.floor(nM)}M`} × ${farDate ? fD(farDate) : `${Math.floor(fM)}M`}`,
        pB, pM, pA, days: ds, fIy,
        nrVD: parseD(ipaN.valueDate) || nVD, frVD: parseD(ipaF.valueDate) || fVD,
        nrFxD: parseD(ipaN.fixDate), frFxD: parseD(ipaF.fixDate),
        nrDT: nDays, frDT: fDays,
        source: "IPA",
      };
    }
  }

  // --- Fallback: interpolation from anchor rows ---
  const nrI = Math.floor(nM), frI = Math.floor(fM);
  const mT = ad.maxT || 24;
  const nr = nrI >= 0 && nrI <= mT ? rows.find(r => r.month === nrI) : null;
  const fr = frI >= 0 && frI <= mT ? rows.find(r => r.month === frI) : null;
  if (!nr || !fr) return null;
  const pM = fr.spM != null && nr.spM != null ? fr.spM - nr.spM : null;
  const pB = fr.spB != null && nr.spA != null ? fr.spB - nr.spA : null;
  const pA = fr.spA != null && nr.spB != null ? fr.spA - nr.spB : null;
  const ds = fr.dT - nr.dT;
  const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
  return {
    label: `${nearDate ? fD(nearDate) : `${nrI}M`} × ${farDate ? fD(farDate) : `${frI}M`}`,
    pB, pM, pA, days: ds, fIy,
    nrVD: nVD || nr.valDate, frVD: fVD || fr.valDate,
    nrFxD: nr.fixDate, frFxD: fr.fixDate,
    nrDT: nr.dT, frDT: fr.dT,
    source: "interp",
  };
}
