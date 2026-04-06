// Transform backend snapshot into v1 data structures + run buildAllData pipeline
import { mcI, mid, implYld, fwdFwdIy } from "./calc.js";
import { buildIMMDates, buildTenorDates, computeSpotDate, bizBefore, dateFromSpot, daysBtwn, fD } from "./dates.js";

// Convert backend snapshot JSON → v1-compatible RAW_NDF + RAW_SOFR structures
function snapToRaw(snap) {
  const RAW_NDF = {};
  // Spot
  const sT = snap.spot?.T || {}, sT1 = snap.spot?.T1 || {};
  RAW_NDF.spot = { T: { b: sT.bid, a: sT.ask }, T1: { b: sT1.bid, a: sT1.ask } };
  // Tenors
  for (const m of snap.tenorsM) {
    const t = snap.tenors[m] || snap.tenors[String(m)] || {};
    const tT = t.T || {}, tT1 = t.T1 || {};
    RAW_NDF[m] = {
      T: { b: tT.bid, a: tT.ask }, T1: { b: tT1.bid, a: tT1.ask },
      days: { T: t.days || m * 30, T1: t.days || m * 30 },
    };
  }
  // SOFR
  const RAW_SOFR = {};
  for (const [m, s] of Object.entries(snap.sofr || {})) {
    const sT2 = s.T || {}, sT12 = s.T1 || {};
    RAW_SOFR[+m] = { T: sT2.mid ?? sT2.bid, T1: sT12.mid ?? sT12.bid };
  }
  return { RAW_NDF, RAW_SOFR };
}

// Main build function — equivalent to v1 buildAllData
export function buildAllData(snap, liveQuotes = {}) {
  if (!snap) return null;
  const { RAW_NDF, RAW_SOFR } = snapToRaw(snap);
  const PF = snap.pipFactor || 1e3;
  const dp = snap.outrightDp || 3;
  const knownM = snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  const maxT = knownM[knownM.length - 1] || 24;
  const sofrM = [1, 2, 3, 6, 9, 12, 18, 24].filter(m => m <= Math.max(maxT, 24));

  const SPOT_DATE = computeSpotDate();
  const IMM_DATES = buildIMMDates(SPOT_DATE);
  const TENOR_DATES = buildTenorDates(SPOT_DATE);

  // Apply live quotes (from WS) on top of snapshot
  function getE(tk, dk) {
    const raw = tk === "spot" ? RAW_NDF.spot[dk] : RAW_NDF[tk]?.[dk];
    if (!raw) return { b: null, a: null };
    // Override with live quote if available
    if (dk === "T" && snap.tenors) {
      const ric = tk === "spot" ? snap.spot?.ric : snap.tenors[tk]?.ric || snap.tenors[String(tk)]?.ric;
      const lq = liveQuotes[ric];
      if (lq) return { b: lq.bid ?? raw.b, a: lq.ask ?? raw.a };
    }
    return raw;
  }

  function anchorSOFR(dk) { const mo = [], va = []; sofrM.forEach(m => { if (RAW_SOFR[m]) { mo.push(m); va.push(RAW_SOFR[m][dk] ?? 0); } }); return { mo, va }; }
  function anchorNDF(dk) {
    const d = [], mi = [], bi = [], ai = [];
    knownM.forEach(m => {
      const k = m === 0 ? "spot" : m;
      const e = getE(k, dk);
      d.push(m === 0 ? 0 : RAW_NDF[m]?.days?.[dk] || m * 30);
      mi.push(mid(e.b, e.a)); bi.push(e.b); ai.push(e.a);
    });
    return { d, mi, bi, ai };
  }

  // Always include spot (0) in anchor arrays
  const knownMFull = [0, ...knownM];
  function anchorNDFFull(dk) {
    const d = [], mi = [], bi = [], ai = [];
    knownMFull.forEach(m => {
      const k = m === 0 ? "spot" : m;
      const e = getE(k, dk);
      d.push(m === 0 ? 0 : RAW_NDF[m]?.days?.[dk] || m * 30);
      mi.push(mid(e.b, e.a)); bi.push(e.b); ai.push(e.a);
    });
    return { d, mi, bi, ai };
  }

  const nT = anchorNDFFull("T"), nT1 = anchorNDFFull("T1"), sT = anchorSOFR("T"), sT1 = anchorSOFR("T1");
  const iMT = mcI(nT.d, nT.mi), iBT = mcI(nT.d, nT.bi), iAT = mcI(nT.d, nT.ai);
  const iMT1 = mcI(nT1.d, nT1.mi), iBT1 = mcI(nT1.d, nT1.bi), iAT1 = mcI(nT1.d, nT1.ai);
  const iDT = mcI(knownMFull, nT.d), iDT1 = mcI(knownMFull, nT1.d);
  const iST = mcI(sT.mo, sT.va), iST1 = mcI(sT1.mo, sT1.va);
  const sMT = mid(nT.bi[0], nT.ai[0]) || 0, sMT1 = mid(nT1.bi[0], nT1.ai[0]) || 0;
  const sBT = nT.bi[0], sAT = nT.ai[0], sBT1 = nT1.bi[0], sAT1 = nT1.ai[0];

  function getRow(month, daysOvr, label, immVD) {
    const isK = knownMFull.includes(month) && !daysOvr;
    const dT = daysOvr || Math.round(iDT(month)), dT1 = daysOvr ? Math.round(iDT1(month) + (daysOvr - iDT(month))) : Math.round(iDT1(month));
    let bT, aT, mT, bT1, aT1, mT1;
    if (isK && month > 0) { const eT = getE(month, "T"), eT1 = getE(month, "T1"); bT = eT.b; aT = eT.a; mT = mid(bT, aT); bT1 = eT1.b; aT1 = eT1.a; mT1 = mid(bT1, aT1); }
    else if (month === 0 || daysOvr === 0) { const eT = getE("spot", "T"), eT1 = getE("spot", "T1"); bT = eT.b; aT = eT.a; mT = mid(bT, aT); bT1 = eT1.b; aT1 = eT1.a; mT1 = mid(bT1, aT1); }
    else { mT = iMT(dT); bT = iBT(dT); aT = iAT(dT); mT1 = iMT1(dT1); bT1 = iBT1(dT1); aT1 = iAT1(dT1); }
    const sofT = month > 0 ? iST(Math.min(month, 24)) : 0, sofT1 = month > 0 ? iST1(Math.min(month, 24)) : 0;
    const spB = (bT - sMT) * PF, spM = (mT - sMT) * PF, spA = (aT - sMT) * PF;
    const spB1 = (bT1 - sMT1) * PF, spM1 = (mT1 - sMT1) * PF, spA1 = (aT1 - sMT1) * PF;
    const iyB = dT > 0 ? implYld(bT, sAT, sofT, dT) : null;
    const iyM = dT > 0 ? implYld(mT, sMT, sofT, dT) : null;
    const iyA = dT > 0 ? implYld(aT, sBT, sofT, dT) : null;
    const iyB1 = dT1 > 0 ? implYld(bT1, sAT1, sofT1, dT1) : null;
    const iyM1 = dT1 > 0 ? implYld(mT1, sMT1, sofT1, dT1) : null;
    const iyA1 = dT1 > 0 ? implYld(aT1, sBT1, sofT1, dT1) : null;
    const basisT = iyM != null ? iyM - sofT : null, basisT1 = iyM1 != null ? iyM1 - sofT1 : null;
    const iyBpD = iyM != null && dT > 0 ? iyM / 360 * 100 : null;
    const td = TENOR_DATES[Math.round(month)] || {};
    const valDate = immVD || td.valDate || (daysOvr ? dateFromSpot(SPOT_DATE, daysOvr) : null);
    const fixDate = valDate ? bizBefore(valDate, 2) : td.fixDate;
    return {
      tenor: label || (month === 0 ? "Spot" : month <= 12 ? `${month}M` : month === 24 ? "2Y" : `${month}M`),
      month, dT, dT1, bT, aT, mT, bT1, aT1, mT1, spB, spM, spA, spB1, spM1, spA1,
      ptsPerDay: dT > 0 ? spM / dT : 0, sofT, sofT1, iyB, iyM, iyA, iyB1, iyM1, iyA1,
      basisT, basisT1, iyBpD, interp: !isK && month !== 0, valDate, fixDate,
    };
  }

  const rows = []; for (let m = 0; m <= maxT; m++) rows.push(getRow(m));
  const immR = IMM_DATES.filter(im => im.days <= maxT * 31).map(im => getRow(im.days / 30.44, im.days, im.label, im.valDate));

  // Fwd-fwd chain
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = i > 0 ? rows[i - 1] : null;
    r.ffB = i === 0 ? 0 : r.spB - (p?.spA || 0); r.ffM = i === 0 ? 0 : r.spM - (p?.spM || 0); r.ffA = i === 0 ? 0 : r.spA - (p?.spB || 0);
    r.ffB1 = i === 0 ? 0 : r.spB1 - (p?.spA1 || 0); r.ffM1 = i === 0 ? 0 : r.spM1 - (p?.spM1 || 0); r.ffA1 = i === 0 ? 0 : r.spA1 - (p?.spB1 || 0);
    r.ffIyB = p ? fwdFwdIy(p.iyA, p.dT, r.iyB, r.dT) : null;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyA = p ? fwdFwdIy(p.iyB, p.dT, r.iyA, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    const fwdD = p ? r.dT - p.dT : 0;
    r.ffSofr = fwdD > 0 ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + (p?.sofT || 0) / 100 * (p?.dT || 0) / 360) - 1) * 360 / fwdD * 100 : null;
    r.ffBasis = r.ffIyM != null && r.ffSofr != null ? r.ffIyM - r.ffSofr : null;
    r.ffIyBpD = r.ffIyM != null && fwdD > 0 ? r.ffIyM / 360 * 100 : null;
    r.pipChg = r.spM - r.spM1; r.ffChg = r.ffM - r.ffM1;
    r.iyChg = (r.iyM || 0) - (r.iyM1 || 0); r.sofChg = r.sofT - r.sofT1;
    r.basChg = (r.basisT || 0) - (r.basisT1 || 0); r.ffIyChg = (r.ffIyM || 0) - (r.ffIyM1 || 0);
    r.carryOutP = r.ffM; r.carryFfP = i >= 2 ? r.ffM - p.ffM : (i === 1 ? r.ffM : 0);
    r.carryOutY = i > 0 ? (r.iyM || 0) - (p?.iyM || 0) : 0;
    r.carryFfY = i >= 2 ? (r.ffIyM || 0) - (p?.ffIyM || 0) : (i === 1 ? (r.ffIyM || 0) : 0);
  }
  // IMM D/D
  for (let i = 0; i < immR.length; i++) {
    const r = immR[i], p = i > 0 ? immR[i - 1] : null;
    r.pipChg = r.spM - r.spM1; r.iyChg = (r.iyM || 0) - (r.iyM1 || 0); r.sofChg = r.sofT - r.sofT1;
    r.basChg = (r.basisT || 0) - (r.basisT1 || 0); r.ptsPerDay = r.dT > 0 ? r.spM / r.dT : 0;
    r.ffB = i === 0 ? r.spB : r.spB - (p?.spA || 0); r.ffM = i === 0 ? r.spM : r.spM - (p?.spM || 0); r.ffA = i === 0 ? r.spA : r.spA - (p?.spB || 0);
    r.ffM1 = i === 0 ? r.spM1 : r.spM1 - (p?.spM1 || 0); r.ffChg = r.ffM - r.ffM1;
    r.ffIyM = p ? fwdFwdIy(p.iyM, p.dT, r.iyM, r.dT) : null;
    r.ffIyM1 = p ? fwdFwdIy(p.iyM1, p.dT1, r.iyM1, r.dT1) : null;
    r.ffIyChg = (r.ffIyM || 0) - (r.ffIyM1 || 0);
    const fwdD = p ? r.dT - p.dT : r.dT;
    r.ffSofr = p && fwdD > 0 ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + (p.sofT / 100) * p.dT / 360) - 1) * 360 / fwdD * 100 : (r.sofT || 0);
    r.ffBasis = r.ffIyM != null ? r.ffIyM - (r.ffSofr || 0) : null;
  }

  // Spreads
  function mkSpr(nrM, frM, label) {
    const nr = rows[nrM], fr = rows[frM];
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
    return { label, pB, pM, pA, pB1, pM1, pA1, chg: pM - pM1, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFD: nr.fixDate, frFD: fr.fixDate,
      fIyB, fIy, fIyA, fIy1, iyChg: (fIy || 0) - (fIy1 || 0), fSof, fSof1, sofChg: fSof - fSof1,
      bas, basChg: (bas || 0) - ((fIy1 || 0) - (fSof1 || 0)), ppd: ds > 0 ? pM / ds : 0, iyBpD: fIy != null ? fIy / 360 * 100 : null };
  }

  // NDF anchor spreads vs deliverable straight-tenor spreads
  let anchors, qFF, spSpr;
  if (snap.spreadPack === "NDF") {
    const anchorDefs = [[1, 2, "1Mx2M"], [1, 3, "1Mx3M"], [1, 6, "1Mx6M"], [1, 9, "1Mx9M"], [1, 12, "1Mx12M"], [12, 18, "12Mx18M"], [12, 24, "12Mx2Y"]];
    anchors = anchorDefs.filter(([n, f]) => f <= maxT && n <= maxT).map(([n, f, l]) => mkSpr(n, f, l)).filter(Boolean);
    qFF = []; for (let n = 3; n <= 21; n += 3) { const f = n + 3; if (f <= maxT) { const s = mkSpr(n, f, `${n}M×${f <= 12 ? f + "M" : f === 24 ? "2Y" : f + "M"}`); if (s) qFF.push(s); } }
  } else {
    // Deliverable: straight tenors (SPxNM) + occasional fwd-fwds
    anchors = [];
    qFF = [];
    // 1M and 3M fwd-fwds that sometimes trade
    const fwdFwdDefs = [[1, 2, "1M fwd-fwd"], [3, 6, "3M fwd-fwd"]];
    for (const [n, f, l] of fwdFwdDefs) { if (f <= maxT) { const s = mkSpr(n, f, l); if (s) qFF.push(s); } }
  }
  spSpr = [1, 2, 3, 6, 9, 12, 18, 24].filter(f => f <= maxT).map(f => mkSpr(0, f, `SP×${f <= 12 ? f + "M" : "2Y"}`)).filter(Boolean);

  // IMM spreads
  const immSpr = [];
  for (let i = 0; i < immR.length - 1; i++) {
    const nr = immR[i], fr = immR[i + 1]; const pM = fr.spM - nr.spM, pM1 = fr.spM1 - nr.spM1; const ds = fr.dT - nr.dT;
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT); const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    const fSof = ds > 0 ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + (nr.sofT / 100) * nr.dT / 360) - 1) * 360 / ds * 100 : 0;
    immSpr.push({ label: `${nr.tenor.split(" ")[1]}→${fr.tenor.split(" ")[1]}`, pB: 0, pM, pA: 0, pB1: 0, pM1, pA1: 0, chg: pM - pM1, days: ds, nrVD: nr.valDate, frVD: fr.valDate,
      fIyB: null, fIy, fIyA: null, fIy1, iyChg: (fIy || 0) - (fIy1 || 0), fSof, sofChg: fSof - ((ds > 0 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + (nr.sofT1 / 100) * nr.dT1 / 360) - 1) * 360 / ds * 100 : 0)), bas: fIy != null ? fIy - fSof : null, basChg: 0, ppd: ds > 0 ? pM / ds : 0, iyBpD: fIy != null ? fIy / 360 * 100 : null });
  }

  const cfg = { pair: snap.pair, pipFactor: PF, dp, kind: snap.kind, spreadPack: snap.spreadPack };
  return { rows, immR, anchors, qFF, spSpr, immSpr, sMT, sMT1, sBT, sAT, cfg, ccy: snap.ccy, maxT, SPOT_DATE, TENOR_DATES };
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
  const nr = nrI >= 0 && nrI <= mT ? rows[nrI] : null;
  const fr = frI >= 0 && frI <= mT ? rows[frI] : null;
  if (!nr || !fr) return null;
  const pM = fr.spM - nr.spM, pB = fr.spB - nr.spA, pA = fr.spA - nr.spB; const ds = fr.dT - nr.dT;
  const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
  return { label: `${nearDate ? fD(nearDate) : `${nrI}M`} × ${farDate ? fD(farDate) : `${frI}M`}`, pB, pM, pA, days: ds, fIy, nrVD: nVD || nr.valDate, frVD: fVD || fr.valDate };
}
