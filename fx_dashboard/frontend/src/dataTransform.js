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
      T: sT2.mid ?? sT2.last ?? sT2.bid ?? 0,
      T1: sT12.mid ?? sT12.last ?? sT12.bid ?? 0,
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


// Main build function
export function buildAllData(snap, liveQuotes = {}) {
  if (!snap) return null;
  const { RAW, RAW_SOFR } = snapToRaw(snap);
  const PF = snap.pipFactor || 1e3;
  const dp = snap.outrightDp || 3;
  const pipDp = snap.pipDp || 1;
  const knownM = snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  const maxT = snap.maxDisplayM || knownM[knownM.length - 1] || 24;
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
      if (RAW_SOFR[m]) { mo.push(m); va.push(RAW_SOFR[m][dk] ?? 0); }
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
    const dT = daysOvr || Math.round(iDT(month));
    const dT1 = daysOvr ? Math.round(iDT1(month) + (daysOvr - iDT(month))) : Math.round(iDT1(month));

    let spB, spM, spA, spB1, spM1, spA1;
    if (month === 0) {
      spB = 0; spM = 0; spA = 0; spB1 = 0; spM1 = 0; spA1 = 0;
    } else if (isK) {
      const p = getPts(month, "T"), p1 = getPts(month, "T1");
      spB = p.b; spM = p.m; spA = p.a;
      spB1 = p1.b; spM1 = p1.m; spA1 = p1.a;
    } else {
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

    const sofT = month > 0 ? iST(Math.min(month, 24)) : 0;
    const sofT1 = month > 0 ? iST1(Math.min(month, 24)) : 0;

    const iyB = dT > 0 ? implYld(bT, sAT, sofT, dT) : null;
    const iyM = dT > 0 ? implYld(mT, sMT, sofT, dT) : null;
    const iyA = dT > 0 ? implYld(aT, sBT, sofT, dT) : null;
    const iyB1 = dT1 > 0 ? implYld(bT1, sAT1, sofT1, dT1) : null;
    const iyM1 = dT1 > 0 ? implYld(mT1, sMT1, sofT1, dT1) : null;
    const iyA1 = dT1 > 0 ? implYld(aT1, sBT1, sofT1, dT1) : null;

    const basisT = iyM != null ? iyM - sofT : null;
    const basisT1 = iyM1 != null ? iyM1 - sofT1 : null;
    const iyBpD = iyM != null && dT > 0 ? iyM / 360 * 100 : null;

    const td = TENOR_DATES[Math.round(month)] || {};
    const valDate = immVD || td.valDate || (daysOvr ? dateFromSpot(SPOT_DATE, daysOvr) : null);
    const fixDate = valDate ? bizBefore(valDate, 2) : td.fixDate;

    return {
      tenor: label || (month === 0 ? "Spot" : month <= 12 ? `${month}M` : month === 24 ? "2Y" : `${month}M`),
      month, dT, dT1,
      bT, aT, mT, bT1, aT1, mT1,
      spB: spB ?? 0, spM: spM ?? 0, spA: spA ?? 0,
      spB1: spB1 ?? 0, spM1: spM1 ?? 0, spA1: spA1 ?? 0,
      ptsPerDay: dT > 0 ? (spM ?? 0) / dT : 0,
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
    r.ffB = i === 0 ? 0 : r.spB - (p?.spA || 0);
    r.ffM = i === 0 ? 0 : r.spM - (p?.spM || 0);
    r.ffA = i === 0 ? 0 : r.spA - (p?.spB || 0);
    r.ffB1 = i === 0 ? 0 : r.spB1 - (p?.spA1 || 0);
    r.ffM1 = i === 0 ? 0 : r.spM1 - (p?.spM1 || 0);
    r.ffA1 = i === 0 ? 0 : r.spA1 - (p?.spB1 || 0);
    r.ffIyB = p ? fwdFwdIy(p.iyA, p.dT, r.iyB, r.dT) : null;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyA = p ? fwdFwdIy(p.iyB, p.dT, r.iyA, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    const fwdD = p ? r.dT - p.dT : 0;
    r.ffSofr = fwdD > 0 ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + (p?.sofT || 0) / 100 * (p?.dT || 0) / 360) - 1) * 360 / fwdD * 100 : null;
    r.ffBasis = r.ffIyM != null && r.ffSofr != null ? r.ffIyM - r.ffSofr : null;
    r.ffIyBpD = r.ffIyM != null && fwdD > 0 ? r.ffIyM / 360 * 100 : null;
    r.pipChg = r.spM - r.spM1;
    r.ffChg = r.ffM - r.ffM1;
    r.iyChg = (r.iyM || 0) - (r.iyM1 || 0);
    r.sofChg = r.sofT - r.sofT1;
    r.basChg = (r.basisT || 0) - (r.basisT1 || 0);
    r.ffIyChg = (r.ffIyM || 0) - (r.ffIyM1 || 0);
    r.carryOutP = r.ffM;
    r.carryFfP = i >= 2 ? r.ffM - p.ffM : (i === 1 ? r.ffM : 0);
    r.carryOutY = i > 0 ? (r.iyM || 0) - (p?.iyM || 0) : 0;
    r.carryFfY = i >= 2 ? (r.ffIyM || 0) - (p?.ffIyM || 0) : (i === 1 ? (r.ffIyM || 0) : 0);
    // Roll-down columns
    r.rollPts = i >= 2 ? r.ffM - (p?.ffM || 0) : null;
    r.rollIy = i >= 2 ? (r.ffIyM || 0) - (p?.ffIyM || 0) : null;
  }

  // IMM D/D
  for (let i = 0; i < immR.length; i++) {
    const r = immR[i], p = i > 0 ? immR[i - 1] : null;
    r.pipChg = r.spM - r.spM1;
    r.iyChg = (r.iyM || 0) - (r.iyM1 || 0);
    r.sofChg = r.sofT - r.sofT1;
    r.basChg = (r.basisT || 0) - (r.basisT1 || 0);
    r.ptsPerDay = r.dT > 0 ? r.spM / r.dT : 0;
    r.ffB = i === 0 ? r.spB : r.spB - (p?.spA || 0);
    r.ffM = i === 0 ? r.spM : r.spM - (p?.spM || 0);
    r.ffA = i === 0 ? r.spA : r.spA - (p?.spB || 0);
    r.ffM1 = i === 0 ? r.spM1 : r.spM1 - (p?.spM1 || 0);
    r.ffChg = r.ffM - r.ffM1;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    r.ffIyChg = (r.ffIyM || 0) - (r.ffIyM1 || 0);
    const fwdD = p ? r.dT - p.dT : r.dT;
    r.ffSofr = p && fwdD > 0 ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + (p.sofT / 100) * p.dT / 360) - 1) * 360 / fwdD * 100 : (r.sofT || 0);
    r.ffBasis = r.ffIyM != null ? r.ffIyM - (r.ffSofr || 0) : null;
  }

  // Spreads — find rows by month, NOT by index
  function mkSpr(nrM, frM, label) {
    const nr = rows.find(r => r.month === nrM);
    const fr = rows.find(r => r.month === frM);
    if (!nr || !fr) return null;
    const pB = fr.spB - nr.spA, pM = fr.spM - nr.spM, pA = fr.spA - nr.spB;
    const pB1 = fr.spB1 - nr.spA1, pM1 = fr.spM1 - nr.spM1, pA1 = fr.spA1 - nr.spB1;
    const ds = fr.dT - nr.dT;
    const fIyB = fwdFwdIy(nr.iyA, nr.dT, fr.iyB, fr.dT);
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    const fIyA = fwdFwdIy(nr.iyB, nr.dT, fr.iyA, fr.dT);
    const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    const fSof = ds > 0 ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + nr.sofT / 100 * nr.dT / 360) - 1) * 360 / ds * 100 : 0;
    const fSof1 = ds > 0 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + nr.sofT1 / 100 * nr.dT1 / 360) - 1) * 360 / ds * 100 : 0;
    const bas = fIy != null ? fIy - fSof : null;
    return {
      label, pB, pM, pA, pB1, pM1, pA1, chg: pM - pM1, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFD: nr.fixDate, frFD: fr.fixDate,
      nrDT: nr.dT, frDT: fr.dT,
      fIyB, fIy, fIyA, fIy1,
      iyChg: (fIy || 0) - (fIy1 || 0),
      fSof, fSof1, sofChg: fSof - fSof1,
      bas, basChg: (bas || 0) - ((fIy1 || 0) - (fSof1 || 0)),
      ppd: ds > 0 ? pM / ds : 0,
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

  // IMM spreads
  const immSpr = [];
  for (let i = 0; i < immR.length - 1; i++) {
    const nr = immR[i], fr = immR[i+1];
    const pB = fr.spB - nr.spA, pM = fr.spM - nr.spM, pA = fr.spA - nr.spB;
    const pM1 = fr.spM1 - nr.spM1;
    const ds = fr.dT - nr.dT;
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    const fSof = ds > 0 ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + (nr.sofT / 100) * nr.dT / 360) - 1) * 360 / ds * 100 : 0;
    immSpr.push({
      label: `${nr.tenor.split(" ")[1] || nr.tenor}→${fr.tenor.split(" ")[1] || fr.tenor}`,
      pB, pM, pA, pB1: 0, pM1, pA1: 0, chg: pM - pM1, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFD: nr.fixDate, frFD: fr.fixDate,
      nrDT: nr.dT, frDT: fr.dT,
      fIyB: null, fIy, fIyA: null, fIy1,
      iyChg: (fIy || 0) - (fIy1 || 0),
      fSof, sofChg: fSof - ((ds > 0 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + (nr.sofT1 / 100) * nr.dT1 / 360) - 1) * 360 / ds * 100 : 0)),
      bas: fIy != null ? fIy - fSof : null, basChg: 0,
      ppd: ds > 0 ? pM / ds : 0,
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
export function calcCustom(ad, nearM, farM, nearDate, farDate) {
  const { rows, SPOT_DATE } = ad;
  let nM = nearM, fM = farM, nVD = null, fVD = null;
  if (nearDate) { nM = daysBtwn(SPOT_DATE, nearDate) / 30.44; nVD = nearDate; }
  if (farDate) { fM = daysBtwn(SPOT_DATE, farDate) / 30.44; fVD = farDate; }
  if (fM <= nM) return null;
  const nrI = Math.floor(nM), frI = Math.floor(fM);
  const mT = ad.maxT || 24;
  const nr = nrI >= 0 && nrI <= mT ? rows.find(r => r.month === nrI) : null;
  const fr = frI >= 0 && frI <= mT ? rows.find(r => r.month === frI) : null;
  if (!nr || !fr) return null;
  const pM = fr.spM - nr.spM, pB = fr.spB - nr.spA, pA = fr.spA - nr.spB;
  const ds = fr.dT - nr.dT;
  const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
  return {
    label: `${nearDate ? fD(nearDate) : `${nrI}M`} × ${farDate ? fD(farDate) : `${frI}M`}`,
    pB, pM, pA, days: ds, fIy,
    nrVD: nVD || nr.valDate, frVD: fVD || fr.valDate,
    nrFD: nr.fixDate, frFD: fr.fixDate,
    nrDT: nr.dT, frDT: fr.dT,
  };
}
