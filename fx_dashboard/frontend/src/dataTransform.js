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

// Main build function
export function buildAllData(snap, liveQuotes = {}) {
  if (!snap) return null;
  const { RAW, RAW_SOFR } = snapToRaw(snap);
  const PF = snap.pipFactor || 1e3;
  const dp = snap.outrightDp || 3;
  const pipDp = snap.pipDp || 1;
  const knownM = snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  const maxT = snap.maxDisplayM || knownM[knownM.length - 1] || 24;

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

  // Live quote override for spot
  function getLiveSpot(dk) {
    if (dk === "T") {
      const spotRic = snap.spot?.ric;
      const lq = liveQuotes[spotRic];
      if (lq) return { b: lq.bid ?? sBT, a: lq.ask ?? sAT, m: lq.mid ?? mid(lq.bid ?? sBT, lq.ask ?? sAT) };
      return RAW.spot.T;
    }
    return RAW.spot.T1;
  }

  // Get swap points for a tenor, with live override
  function getPts(m, dk) {
    const raw = RAW.pts[m];
    if (!raw) return { b: null, m: null, a: null };
    const base = raw[dk] || { b: null, m: null, a: null };
    if (dk === "T" && snap.tenors) {
      const tenorData = snap.tenors[m] || snap.tenors[String(m)];
      const ric = tenorData?.ric;
      const lq = liveQuotes[ric];
      if (lq) return { b: lq.bid ?? base.b, m: lq.mid ?? mid(lq.bid, lq.ask) ?? base.m, a: lq.ask ?? base.a };
    }
    return base;
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
    const bT = month === 0 ? spot.b : (spot.m != null && spB != null ? spot.m + spB / PF : null);
    const aT = month === 0 ? spot.a : (spot.m != null && spA != null ? spot.m + spA / PF : null);
    const mT = month === 0 ? spot.m : (spot.m != null && spM != null ? spot.m + spM / PF : null);
    const bT1 = month === 0 ? spot1.b : (spot1.m != null && spB1 != null ? spot1.m + spB1 / PF : null);
    const aT1 = month === 0 ? spot1.a : (spot1.m != null && spA1 != null ? spot1.m + spA1 / PF : null);
    const mT1 = month === 0 ? spot1.m : (spot1.m != null && spM1 != null ? spot1.m + spM1 / PF : null);

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

    return {
      tenor: label || (month === 0 ? "Spot" : month <= 12 ? `${month}M` : month === 24 ? "2Y" : `${month}M`),
      month, dT, dT1, dataSource,
      bT, aT, mT, bT1, aT1, mT1,
      spB, spM, spA, spB1, spM1, spA1,
      ptsPerDay: dT > 0 && spM != null ? spM / dT : null,
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
    // Carry: null if underlying is null
    r.carryOutP = r.ffM;
    r.carryFfP = i >= 2 && r.ffM != null && p?.ffM != null ? r.ffM - p.ffM : (i === 1 ? r.ffM : null);
    r.carryOutY = i > 0 && r.iyM != null && p?.iyM != null ? r.iyM - p.iyM : null;
    r.carryFfY = i >= 2 && r.ffIyM != null && p?.ffIyM != null ? r.ffIyM - p.ffIyM : (i === 1 ? r.ffIyM : null);
    // Roll-down: null if underlying is null
    r.rollPts = i >= 2 && r.ffM != null && p?.ffM != null ? r.ffM - p.ffM : null;
    r.rollIy = i >= 2 && r.ffIyM != null && p?.ffIyM != null ? r.ffIyM - p.ffIyM : null;
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
      label, pB, pM, pA, pB1, pM1, pA1, chg: pM != null && pM1 != null ? pM - pM1 : null, days: ds,
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
  const cfg = { pair: snap.pair, pipFactor: PF, dp, pipDp, kind: snap.kind, spreadPack: snap.spreadPack };
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
