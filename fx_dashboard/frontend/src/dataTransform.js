/**
 * Transform backend snapshot → dashboard data.
 *
 * New contract: snapshot.tenors[m].sources[name] = { ric, bid, ask, mid, last,
 *   ts, ageSec, freshness, timact, valueMode, hasData, T1, [sourceKind, outright] }
 * Each source declares valueMode:
 *   - "pips":     display_pts = raw, outright = spot + raw / pipFactor
 *   - "outright": display_pts = raw * pipFactor, outright = spot + raw
 * NGN sources have sourceKind="outright_derived" with source.outright.{bid,ask,mid};
 *   outrightFromSource returns those directly.
 */
import { mcI, mid, implYld, fwdFwdIy } from "./calc.js";
import { buildIMMDates, buildTenorDates, computeSpotDate, bizBefore, dateFromSpot, daysBtwn, fD } from "./dates.js";

// ── Curve-days policy ───────────────────────────────────────────────────
// NDFs price to fixDate (settlement-date curve math uses daysFix).
// Deliverables price to valueDate (days).
// Returns the days-to-use for curve interpolation at tenor-month `m`.
export function daysForCurve(snap, m) {
  if (!snap || !snap.tenors) return null;
  const t = snap.tenors[m] || snap.tenors[String(m)];
  if (!t) return null;
  const isNDF = snap.kind === "NDF";
  if (isNDF && t.daysFix != null) return t.daysFix;
  return t.days ?? null;
}

// ── Source-level helpers (exported) ─────────────────────────────────────
const FRESHNESS_RANK = { fresh: 0, stale: 1, very_stale: 2, unknown: 3 };

// Issue 3: Compute per-source data quality for Manual mode button borders.
// Returns "good" | "bad" | "partial".
export function sourceQuality(snap, brokerCode) {
  if (!snap || !snap.tenors) return "partial";
  const anchorM = snap.anchorTenorsM || snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  let hasDataCount = 0, freshCount = 0, veryStaleCount = 0, total = 0;
  for (const m of anchorM) {
    const t = snap.tenors[m] || snap.tenors[String(m)];
    if (!t || !t.sources) continue;
    total++;
    const s = t.sources[brokerCode];
    if (!s) continue;
    if (s.hasData) {
      hasDataCount++;
      const fr = s.freshness || "unknown";
      if (fr === "fresh" || fr === "stale") freshCount++;
      if (fr === "very_stale") veryStaleCount++;
    }
  }
  if (total === 0) return "partial";
  const hasDataPct = hasDataCount / total;
  const freshPct = freshCount / total;
  // Good: >50% have data AND are fresh/stale
  if (hasDataPct > 0.5 && freshPct > 0.5) return "good";
  // Bad: majority missing OR all data is very_stale
  if (hasDataPct <= 0.5 || (hasDataCount > 0 && veryStaleCount === hasDataCount)) return "bad";
  return "partial";
}

export function pickSource(tenor, selection) {
  // Return first selected source (in selection order) that has data. No silent substitution.
  if (!tenor || !tenor.sources) return null;
  for (const name of selection) {
    const s = tenor.sources[name];
    if (s && s.hasData) return { name, source: s };
  }
  return null;
}

// Merge a T-1 backfill response `{ric: {bid, ask, last} | null}` into a snapshot,
// writing into `source.T1` for any matching RIC in `tenors[m].sources` or
// `funding[T].sources`. Returns a NEW snapshot object (does not mutate input).
export function mergeT1(snap, t1Map) {
  if (!snap || !t1Map) return snap;
  const keys = Object.keys(t1Map);
  if (!keys.length) return snap;
  // Only copy branches we touch; preserve object identity elsewhere for React.
  const patchSources = (sources) => {
    if (!sources) return sources;
    let out = null;
    for (const [name, s] of Object.entries(sources)) {
      if (!s || !s.ric) continue;
      if (!(s.ric in t1Map)) continue;
      const t1 = t1Map[s.ric];
      if (!t1) continue;
      const mid_ = t1.mid != null ? t1.mid : (t1.bid != null && t1.ask != null ? (t1.bid + t1.ask) / 2 : null);
      const newT1 = { bid: t1.bid ?? null, ask: t1.ask ?? null, mid: mid_, last: t1.last ?? null };
      if (!out) out = { ...sources };
      out[name] = { ...s, T1: newT1 };
    }
    return out || sources;
  };
  const patchBundleMap = (bundleMap) => {
    if (!bundleMap) return bundleMap;
    let out = null;
    for (const [k, bundle] of Object.entries(bundleMap)) {
      if (!bundle || !bundle.sources) continue;
      const newSources = patchSources(bundle.sources);
      if (newSources !== bundle.sources) {
        if (!out) out = { ...bundleMap };
        out[k] = { ...bundle, sources: newSources };
      }
    }
    return out || bundleMap;
  };
  const newTenors = patchBundleMap(snap.tenors);
  const newFunding = patchBundleMap(snap.funding);
  if (newTenors === snap.tenors && newFunding === snap.funding) return snap;
  return { ...snap, tenors: newTenors, funding: newFunding };
}

export function displayPtsFromSource(source, pipFactor) {
  if (!source) return { b: null, m: null, a: null };
  const mul = source.valueMode === "outright" ? pipFactor : 1;
  const b = source.bid != null ? source.bid * mul : null;
  const a = source.ask != null ? source.ask * mul : null;
  const m = source.mid != null ? source.mid * mul : (b != null && a != null ? (b + a) / 2 : null);
  return { b, m, a };
}

export function displayPtsFromSourceT1(source, pipFactor) {
  if (!source || !source.T1) return { b: null, m: null, a: null };
  const t1 = source.T1;
  const mul = source.valueMode === "outright" ? pipFactor : 1;
  const b = t1.bid != null ? t1.bid * mul : null;
  const a = t1.ask != null ? t1.ask * mul : null;
  const m = t1.mid != null ? t1.mid * mul : (b != null && a != null ? (b + a) / 2 : null);
  return { b, m, a };
}

export function outrightFromSource(source, spotMid, pipFactor) {
  if (!source) return { b: null, m: null, a: null };
  if (source.sourceKind === "outright_derived" && source.outright) {
    const o = source.outright;
    return { b: o.bid ?? null, m: o.mid ?? null, a: o.ask ?? null };
  }
  if (spotMid == null) return { b: null, m: null, a: null };
  if (source.valueMode === "outright") {
    return {
      b: source.bid != null ? spotMid + source.bid : null,
      m: source.mid != null ? spotMid + source.mid : null,
      a: source.ask != null ? spotMid + source.ask : null,
    };
  }
  // pips mode
  return {
    b: source.bid != null ? spotMid + source.bid / pipFactor : null,
    m: source.mid != null ? spotMid + source.mid / pipFactor : null,
    a: source.ask != null ? spotMid + source.ask / pipFactor : null,
  };
}

// Resolve the valueMode ("pips"|"outright") for a source name on a given snapshot.
// composite → snap.valueMode; broker → snap.brokersMeta[b].valueMode || snap.valueMode.
export function valueModeForSource(snap, sourceName) {
  if (!snap) return "pips";
  if (!sourceName || sourceName === "composite") return snap.valueMode || "pips";
  const bm = snap.brokersMeta || {};
  return (bm[sourceName] && bm[sourceName].valueMode) || snap.valueMode || "pips";
}

export function aggregateSources(tenor, selection, opts = {}) {
  const threshold = opts.threshold || "stale"; // include up to this freshness
  const pipFactor = opts.pipFactor || 1;
  const thrRank = FRESHNESS_RANK[threshold] ?? 1;
  if (!tenor || !tenor.sources) return { b: null, m: null, a: null, n: 0, total: 0, includedSources: [] };
  const acc = { b: [], m: [], a: [] };
  const included = [];
  let total = 0;
  for (const name of selection) {
    const s = tenor.sources[name];
    if (!s || !s.hasData) continue;
    total++;
    const rank = FRESHNESS_RANK[s.freshness] ?? 3;
    if (rank > thrRank) continue;
    const dp = displayPtsFromSource(s, pipFactor);
    if (dp.b != null) acc.b.push(dp.b);
    if (dp.m != null) acc.m.push(dp.m);
    if (dp.a != null) acc.a.push(dp.a);
    included.push(name);
  }
  const avg = (arr) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null;
  return { b: avg(acc.b), m: avg(acc.m), a: avg(acc.a), n: included.length, total, includedSources: included };
}

// ── Build ─────────────────────────────────────────────────────────────
function ipaTenorToMonth(t) {
  if (!t) return null;
  const m = t.match(/^(\d+)(M|Y|W)$/i);
  if (!m) return null;
  const n = parseInt(m[1]), u = m[2].toUpperCase();
  if (u === 'Y') return n * 12;
  if (u === 'W') return n / 4;
  return n;
}

function ricToSourceName(ric, tenor) {
  if (!ric || !tenor || !tenor.sources) return null;
  for (const [name, s] of Object.entries(tenor.sources)) {
    if (s && s.ric === ric) return name;
  }
  return null;
}

export function buildAllData(snap, liveQuotes = {}, selection = null) {
  if (!snap) return null;
  const PF = snap.pipFactor || 1e3;
  const dp = snap.outrightDp || 3;
  const pipDp = snap.pipDp || 1;
  const anchorM = snap.anchorTenorsM || snap.tenorsM || [1, 2, 3, 6, 9, 12, 18, 24];
  // Include extended tenors that actually came back with data so the days-indexed
  // curve has more anchor points (less reliance on interpolation for 4M, 5M, etc.).
  const extendedM = (snap.extendedTenorsM || []).filter(m => {
    if (anchorM.includes(m)) return false;
    const t = snap.tenors?.[m] || snap.tenors?.[String(m)];
    return !!(t && t.hasAnyData);
  });
  const knownM = [...anchorM, ...extendedM].sort((a, b) => a - b);
  const maxT = snap.maxDisplayM || anchorM[anchorM.length - 1] || 24;
  const ccyCode = snap.ccy;
  const isNDF = snap.kind === "NDF";
  const deriveFromOutrights = !!snap.deriveFromOutrights;

  // Default selection if caller passed none
  if (!selection || !selection.length) {
    selection = deriveFromOutrights ? (snap.brokers || []) : ["composite", ...(snap.brokers || [])];
  }

  // IPA by month
  const IPA = {};
  if (snap.ipa) {
    for (const [tStr, data] of Object.entries(snap.ipa)) {
      const m = ipaTenorToMonth(tStr);
      if (m != null && data) IPA[m] = data;
    }
  }

  const SPOT_DATE = computeSpotDate();
  const IMM_DATES = buildIMMDates(SPOT_DATE);
  const TENOR_DATES = buildTenorDates(SPOT_DATE);

  // Spot
  const sT = snap.spot?.T || {}, sT1 = snap.spot?.T1 || {};
  const spotRic = snap.spot?.ric;
  // Live spot override
  const lqSpot = spotRic ? liveQuotes[spotRic] : null;
  const sBT0 = lqSpot?.bid ?? sT.bid;
  const sAT0 = lqSpot?.ask ?? sT.ask;
  const sMT0 = lqSpot?.mid ?? sT.mid ?? mid(sBT0, sAT0);
  const sBT1 = sT1.bid, sAT1 = sT1.ask, sMT1_ = sT1.mid ?? mid(sT1.bid, sT1.ask);

  // NDF 1M outright → derive implied spot (ticks frequently)
  let derivedSpotT = null, derivedSpotT1 = null;
  const ndf1m = snap.ndf1mOutright;
  const ndf1mOutRic = ndf1m?.ric;
  if (isNDF && ndf1m) {
    const oT = ndf1m.T || {}, oT1 = ndf1m.T1 || {};
    const lqOut = ndf1mOutRic ? liveQuotes[ndf1mOutRic] : null;
    const om = (lqOut?.mid ?? oT.mid ?? mid(lqOut?.bid ?? oT.bid, lqOut?.ask ?? oT.ask));
    // 1M composite swap-points → invert valueMode to get spot
    const t1m = (snap.tenors?.[1] || snap.tenors?.["1"]);
    if (t1m && t1m.sources) {
      // prefer selected-and-fresh, else composite, else first
      const pickedForSpot = pickSource(t1m, selection) || pickSource(t1m, ["composite"]) || pickSource(t1m, Object.keys(t1m.sources));
      if (pickedForSpot && om != null) {
        const s = pickedForSpot.source;
        const ptsMid = s.mid ?? mid(s.bid, s.ask);
        if (ptsMid != null) {
          const ptsOutright = s.valueMode === "outright" ? ptsMid : ptsMid / PF;
          derivedSpotT = om - ptsOutright;
          // bid/ask
          const bOut = lqOut?.bid ?? oT.bid;
          const aOut = lqOut?.ask ?? oT.ask;
          const pB = s.bid != null ? (s.valueMode === "outright" ? s.bid : s.bid / PF) : 0;
          const pA = s.ask != null ? (s.valueMode === "outright" ? s.ask : s.ask / PF) : 0;
          derivedSpotT = { b: bOut != null ? bOut - pA : derivedSpotT, m: derivedSpotT, a: aOut != null ? aOut - pB : derivedSpotT };
        }
      }
    }
    // T1
    const om1 = oT1.mid ?? mid(oT1.bid, oT1.ask);
    const t1m_ = (snap.tenors?.[1] || snap.tenors?.["1"]);
    if (t1m_ && om1 != null) {
      const s1 = pickSource(t1m_, selection)?.source;
      const src = s1 && s1.T1 ? s1 : null;
      if (src && src.T1) {
        const ptsMid = src.T1.mid ?? mid(src.T1.bid, src.T1.ask);
        if (ptsMid != null) {
          const mul = src.valueMode === "outright" ? 1 : 1 / PF;
          derivedSpotT1 = { b: oT1.bid != null ? oT1.bid - (src.T1.ask ?? 0) * mul : null,
                            m: om1 - ptsMid * mul,
                            a: oT1.ask != null ? oT1.ask - (src.T1.bid ?? 0) * mul : null };
        }
      }
    }
  }

  function getSpot(dk) {
    if (dk === "T") {
      if (derivedSpotT && typeof derivedSpotT === "object") return derivedSpotT;
      return { b: sBT0, m: sMT0, a: sAT0 };
    }
    if (derivedSpotT1) return derivedSpotT1;
    return { b: sBT1, m: sMT1_, a: sAT1 };
  }

  const spotT = getSpot("T"), spotT1 = getSpot("T1");
  const sMT = spotT.m ?? 0, sBT = spotT.b, sAT = spotT.a;
  const sMT1 = spotT1.m ?? 0;

  // SOFR
  const RAW_SOFR = {};
  for (const [m, s] of Object.entries(snap.sofr || {})) {
    const t = s.T || {}, t1 = s.T1 || {};
    RAW_SOFR[+m] = {
      T: t.mid ?? t.last ?? t.bid ?? null,
      T1: t1.mid ?? t1.last ?? t1.bid ?? null,
    };
  }
  const sofrM = [1, 2, 3, 6, 9, 12, 18, 24].filter(m => m <= Math.max(maxT, 24));

  // Apply live quotes to source objects so aggregation sees latest ticks.
  // We clone shallowly: for each tenor, for each source, if liveQuotes has the ric, override bid/ask/mid/ts/ageSec/freshness.
  function applyLiveToTenor(rawTenor) {
    if (!rawTenor || !rawTenor.sources) return rawTenor;
    const out = { ...rawTenor, sources: {} };
    for (const [name, s] of Object.entries(rawTenor.sources)) {
      if (!s) continue;
      const lq = s.ric ? liveQuotes[s.ric] : null;
      if (lq) {
        out.sources[name] = {
          ...s,
          bid: lq.bid ?? s.bid,
          ask: lq.ask ?? s.ask,
          mid: lq.mid ?? (lq.bid != null && lq.ask != null ? (lq.bid + lq.ask) / 2 : s.mid),
          ts: lq.ts ?? s.ts,
          ageSec: lq.ageSec ?? s.ageSec,
          freshness: lq.freshness ?? s.freshness,
          timact: lq.timact ?? s.timact,
          hasData: true,
        };
      } else {
        out.sources[name] = s;
      }
    }
    return out;
  }

  // Per-tenor swap-points (T): aggregate across selected sources in display-pts units.
  function getPts(m, dk) {
    const rawTenor = snap.tenors?.[m] || snap.tenors?.[String(m)];
    if (!rawTenor) return { b: null, m: null, a: null, n: 0, total: 0, picked: null };
    const t = applyLiveToTenor(rawTenor);
    if (dk === "T") {
      const agg = aggregateSources(t, selection, { pipFactor: PF, threshold: "stale" });
      if (agg.n === 0) return { b: null, m: null, a: null, n: 0, total: agg.total, picked: null };
      return { b: agg.b, m: agg.m, a: agg.a, n: agg.n, total: agg.total, picked: agg.includedSources[0] };
    }
    // T1: pick first selected with T1 that has actual data (prev-day — no live override needed).
    // Issue 3 fix: T1 is always an object — check that it contains non-null values before accepting.
    for (const name of selection) {
      const s = rawTenor.sources[name];
      if (!s || !s.hasData || !s.T1) continue;
      const dp = displayPtsFromSourceT1(s, PF);
      if (dp.m != null || dp.b != null || dp.a != null) {
        return { ...dp, n: 1, total: 1, picked: name };
      }
    }
    // Fallback: try ALL sources (not just selected) for T1 data
    for (const [name, s] of Object.entries(rawTenor.sources || {})) {
      if (!s || !s.T1) continue;
      const dp = displayPtsFromSourceT1(s, PF);
      if (dp.m != null || dp.b != null || dp.a != null) {
        return { ...dp, n: 1, total: 1, picked: name };
      }
    }
    return { b: null, m: null, a: null, n: 0, total: 0, picked: null };
  }

  function anchorPts(dk) {
    const mo = [0], pM = [0], pB = [0], pA = [0], days = [0];
    knownM.forEach(m => {
      const p = getPts(m, dk);
      if (p.b == null && p.a == null && p.m == null) return;
      mo.push(m);
      // Use fixDate-based days for NDFs (when available), valueDate for deliverables.
      const d = daysForCurve(snap, m);
      days.push(d != null ? d : m * 30);
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
  const sTa = anchorSOFR("T"), sT1a = anchorSOFR("T1");
  const iPtMT = mcI(ptT.days, ptT.pM), iPtBT = mcI(ptT.days, ptT.pB), iPtAT = mcI(ptT.days, ptT.pA);
  const iPtMT1 = mcI(ptT1.days, ptT1.pM), iPtBT1 = mcI(ptT1.days, ptT1.pB), iPtAT1 = mcI(ptT1.days, ptT1.pA);
  const iDT = mcI(ptT.mo, ptT.days), iDT1 = mcI(ptT1.mo, ptT1.days);
  const iST = mcI(sTa.mo, sTa.va), iST1 = mcI(sT1a.mo, sT1a.va);
  // SOFR is provided at [1,2,3,6,9,12,18,24] months. Calling iST below 1M
  // extrapolates a monotone-cubic spline below its data range — the result
  // can be wildly off (negative or huge), making implied yield NaN/null for
  // weekly and funding tenors. Use 1M SOFR as a flat floor for sub-1M; the
  // resulting IY error is small and shows a sensible value instead of "—".
  const sofAt   = (m) => sTa.mo.length  ? iST (Math.max(1, Math.min(m, 24))) : null;
  const sofAt1  = (m) => sT1a.mo.length ? iST1(Math.max(1, Math.min(m, 24))) : null;

  // Issue 3: For deriveFromOutrights ccys, build outright interpolation curves.
  // Interpolate outrights directly (smoother for EGP/NGN), then derive swap points.
  let iOutMT = null, iOutBT = null, iOutAT = null;
  if (deriveFromOutrights && sMT != null) {
    const outDays = [0], outM = [sMT], outB = [sMT], outA = [sMT];
    knownM.forEach(m => {
      const rawT = snap.tenors?.[m] || snap.tenors?.[String(m)];
      if (!rawT) return;
      const picked = pickSource(applyLiveToTenor(rawT), selection);
      if (picked && picked.source.outright) {
        const o = picked.source.outright;
        const d = daysForCurve(snap, m);
        if (d != null && o.mid != null) {
          outDays.push(d);
          outM.push(o.mid);
          outB.push(o.bid ?? o.mid);
          outA.push(o.ask ?? o.mid);
        }
      }
    });
    if (outDays.length >= 2) {
      iOutMT = mcI(outDays, outM);
      iOutBT = mcI(outDays, outB);
      iOutAT = mcI(outDays, outA);
    }
  }

  function getRow(month, daysOvr, label, immVD) {
    const isK = (month === 0 || knownM.includes(month)) && !daysOvr;
    const ipaD = IPA[month];
    // For anchor tenors on NDFs, prefer backend fixDate-based days so curve math
    // and displayed D are consistent with the interpolated curve.
    const anchorD = isK && month > 0 ? daysForCurve(snap, month) : null;
    const dT = daysOvr || (anchorD != null ? anchorD : (ipaD?.days != null ? Math.round(ipaD.days) : Math.round(iDT(month))));
    const dT1 = daysOvr ? Math.round(iDT1(month) + (daysOvr - iDT(month))) : Math.round(iDT1(month));
    let dataSource = month === 0 ? "spot" : isK ? "RIC" : (ipaD ? "IPA" : "interp");

    // NOTE: display-pts (spB/spM/spA) are in PIP units regardless of source valueMode.
    let spB, spM, spA, spB1, spM1, spA1;
    if (month === 0) {
      spB = 0; spM = 0; spA = 0; spB1 = 0; spM1 = 0; spA1 = 0;
    } else if (isK) {
      const p = getPts(month, "T"), p1 = getPts(month, "T1");
      spB = p.b; spM = p.m; spA = p.a;
      spB1 = p1.b; spM1 = p1.m; spA1 = p1.a;
    } else if (deriveFromOutrights && !isK && month > 0) {
      // Issue 3: For outright-derived ccys (EGP, NGN), interpolate the OUTRIGHT curve
      // first, then derive swap points = (outright - spot) * pipFactor.
      const interpOutM = iOutMT ? iOutMT(dT) : null;
      const interpOutB = iOutBT ? iOutBT(dT) : null;
      const interpOutA = iOutAT ? iOutAT(dT) : null;
      if (interpOutM != null && sMT != null) {
        spM = (interpOutM - sMT) * PF;
        spB = interpOutB != null ? (interpOutB - sMT) * PF : spM;
        spA = interpOutA != null ? (interpOutA - sMT) * PF : spM;
      } else {
        spM = iPtMT(dT); spB = iPtBT(dT); spA = iPtAT(dT);
      }
      spM1 = iPtMT1(dT1); spB1 = iPtBT1(dT1); spA1 = iPtAT1(dT1);
    } else if (ipaD && ipaD.fwdPoints != null) {
      const ipaM = ipaD.fwdPoints;
      const interpM = iPtMT(dT), interpB = iPtBT(dT), interpA = iPtAT(dT);
      if (interpM != null && interpB != null && interpA != null) {
        const shift = ipaM - interpM;
        spB = interpB + shift; spM = ipaM; spA = interpA + shift;
      } else { spB = ipaM; spM = ipaM; spA = ipaM; }
      spM1 = iPtMT1(dT1); spB1 = iPtBT1(dT1); spA1 = iPtAT1(dT1);
    } else {
      spM = iPtMT(dT); spB = iPtBT(dT); spA = iPtAT(dT);
      spM1 = iPtMT1(dT1); spB1 = iPtBT1(dT1); spA1 = iPtAT1(dT1);
    }

    // Outrights — ALWAYS computed from spot + display-pts / PF for a single pipeline.
    // (NDF 1M outright RIC is used only to DERIVE the spot; the row's outright is
    // reconstructed so it equals spot + pts/PF — matching every other tenor.)
    let bT, aT, mT, bT1, aT1, mT1;
    if (month === 0) {
      bT = spotT.b; aT = spotT.a; mT = spotT.m;
      bT1 = spotT1.b; aT1 = spotT1.a; mT1 = spotT1.m;
    } else if (deriveFromOutrights && isK) {
      // NGN and similar: sources carry outright.{bid,ask,mid} — use them directly (pick first selected).
      const rawT = snap.tenors?.[month] || snap.tenors?.[String(month)];
      const picked = pickSource(applyLiveToTenor(rawT), selection);
      if (picked && picked.source.outright) {
        const o = picked.source.outright;
        bT = o.bid; aT = o.ask; mT = o.mid;
      } else {
        bT = null; aT = null; mT = null;
      }
      // T1 outrights not typically available for NGN-style — leave null for now.
      bT1 = null; aT1 = null; mT1 = null;
    } else {
      // Build from spot + display-pts / PF (display-pts are always in pip units).
      bT = spotT.m != null && spB != null ? spotT.m + spB / PF : null;
      aT = spotT.m != null && spA != null ? spotT.m + spA / PF : null;
      mT = spotT.m != null && spM != null ? spotT.m + spM / PF : null;
      bT1 = spotT1.m != null && spB1 != null ? spotT1.m + spB1 / PF : null;
      aT1 = spotT1.m != null && spA1 != null ? spotT1.m + spA1 / PF : null;
      mT1 = spotT1.m != null && spM1 != null ? spotT1.m + spM1 / PF : null;
    }

    const sofTRaw = month > 0 ? sofAt(month) : null;
    const sofT1Raw = month > 0 ? sofAt1(month) : null;
    const sofT = sofTRaw != null && isFinite(sofTRaw) ? sofTRaw : (month === 0 ? 0 : null);
    const sofT1 = sofT1Raw != null && isFinite(sofT1Raw) ? sofT1Raw : (month === 0 ? 0 : null);

    let iyB, iyM, iyA, iyB1, iyM1, iyA1;
    if (ipaD && ipaD.impliedYield != null && !isK && month > 0) {
      iyM = ipaD.impliedYield;
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

    const td = TENOR_DATES[Math.round(month)] || {};
    const ipaValDate = ipaD?.valueDate ? new Date(ipaD.valueDate) : null;
    const ipaFixDate = ipaD?.fixDate ? new Date(ipaD.fixDate) : null;
    const valDate = immVD || ipaValDate || td.valDate || (daysOvr ? dateFromSpot(SPOT_DATE, daysOvr) : null);
    const fixDate = ipaFixDate || (valDate ? bizBefore(valDate, 2) : td.fixDate);

    // Source metadata for UI (staleness + n/N fresh). Only populated for anchor tenors.
    let sourcesMeta = null;
    if (isK && month > 0) {
      const rawT = snap.tenors?.[month] || snap.tenors?.[String(month)];
      if (rawT) {
        const t = applyLiveToTenor(rawT);
        const agg = aggregateSources(t, selection, { pipFactor: PF, threshold: "stale" });
        // Include ALL sources (independent of selection) so BrokerMon can always render every broker.
        const allSourceNames = Object.keys(t.sources || {});
        sourcesMeta = {
          n: agg.n, total: agg.total, includedSources: agg.includedSources,
          bySource: Object.fromEntries(allSourceNames.map(name => {
            const s = t.sources?.[name];
            if (!s || !s.hasData) return [name, null];
            const dpv = displayPtsFromSource(s, PF);
            return [name, { b: dpv.b, m: dpv.m, a: dpv.a, freshness: s.freshness, timact: s.timact, ageSec: s.ageSec, ric: s.ric }];
          })),
        };
      }
    }

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
      sourcesMeta,
    };
  }

  // Weekly tenors (deliverables 0.25/0.5/0.75 → 1W/2W/3W; NDF single 1W in backend served by SWNDF).
  // Use snap.weeklyTenors which reflects per-ccy config.
  const weeklyTenors = snap.weeklyTenors || [];
  const weekLabel = (w) => {
    if (Math.abs(w - 0.25) < 1e-6) return "1W";
    if (Math.abs(w - 0.5) < 1e-6) return "2W";
    if (Math.abs(w - 0.75) < 1e-6) return "3W";
    return `${Math.round(w * 4)}W`;
  };

  const rows = [getRow(0)];
  // Weekly real-RIC overlay: snap.weekly = {SW,2W,3W: {bid,ask,mid,hasData,...}}
  // For NDF only SW exists (=1W). For deliverable all three (SW=1W, 2W, 3W).
  const weeklyBlock = snap.weekly || {};
  const weeklyRicKey = (w) => {
    if (Math.abs(w - 0.25) < 1e-6) return "SW";
    if (Math.abs(w - 0.5) < 1e-6) return "2W";
    if (Math.abs(w - 0.75) < 1e-6) return "3W";
    return null;
  };
  for (const w of weeklyTenors) {
    const wr = getRow(w, Math.round(w * 30), weekLabel(w));
    wr.isWeekly = true;
    // Try live weekly RIC data; valueMode follows snap.valueMode.
    const wk = weeklyBlock[weeklyRicKey(w)];
    if (wk && wk.hasData && wk.ric) {
      // live override
      const lq = liveQuotes[wk.ric];
      const raw_b = lq?.bid ?? wk.bid;
      const raw_a = lq?.ask ?? wk.ask;
      const raw_m = lq?.mid ?? wk.mid ?? mid(raw_b, raw_a);
      const mul = (wk.valueMode === "outright") ? PF : 1;
      const spB = raw_b != null ? raw_b * mul : null;
      const spA = raw_a != null ? raw_a * mul : null;
      const spM = raw_m != null ? raw_m * mul : null;
      if (spM != null) {
        // Issue 6: sanity check — if weekly magnitude > 5x the 1M anchor, flag as suspect
        const anchor1M = getPts(1, "T");
        const anchor1MMag = anchor1M.m != null ? Math.abs(anchor1M.m) : null;
        const weeklyMag = Math.abs(spM);
        const isSuspect = anchor1MMag != null && anchor1MMag > 0 && weeklyMag > 5 * anchor1MMag;
        if (isSuspect) {
          wr.suspect = true;
          wr.suspectReason = "weekly value inconsistent with 1M";
          wr.interp = true; // fall back to interpolation
          wr.dataSource = "weeklyRIC_suspect";
        } else {
          wr.spB = spB; wr.spM = spM; wr.spA = spA;
          wr.bT = spotT.m != null && spB != null ? spotT.m + spB / PF : wr.bT;
          wr.aT = spotT.m != null && spA != null ? spotT.m + spA / PF : wr.aT;
          wr.mT = spotT.m != null && spM != null ? spotT.m + spM / PF : wr.mT;
          wr.interp = false;
          wr.dataSource = "weeklyRIC";
        }
      } else {
        wr.interp = true;
      }
    } else {
      wr.interp = true;
    }
    rows.push(wr);
  }
  for (let m = 1; m <= maxT; m++) rows.push(getRow(m));

  // Issue 5: Interpolate through broker gaps in Manual mode.
  // When selected sources leave gaps (spM == null for non-zero months), fill from
  // the selected sources' own sparse curve via monotone-cubic interpolation.
  {
    const sparseXs = [], sparseYsM = [], sparseYsB = [], sparseYsA = [];
    for (const r of rows) {
      if (r.month > 0 && r.spM != null && !r.isWeekly) {
        const d = r.dT || r.month * 30;
        sparseXs.push(d);
        sparseYsM.push(r.spM);
        sparseYsB.push(r.spB ?? r.spM);
        sparseYsA.push(r.spA ?? r.spM);
      }
    }
    if (sparseXs.length >= 2) {
      const gapInterpM = mcI(sparseXs, sparseYsM);
      const gapInterpB = mcI(sparseXs, sparseYsB);
      const gapInterpA = mcI(sparseXs, sparseYsA);
      for (const r of rows) {
        if (r.month > 0 && r.spM == null && !r.isWeekly) {
          const d = r.dT || r.month * 30;
          // Only interpolate within the range of available data (no extrapolation)
          if (d >= sparseXs[0] && d <= sparseXs[sparseXs.length - 1]) {
            r.spM = gapInterpM(d);
            r.spB = gapInterpB(d);
            r.spA = gapInterpA(d);
            r.interp = true;
            r.interpolated = true;
            r.dataSource = "broker_interp";
            // Recompute outright from interpolated pts
            if (spotT.m != null) {
              r.bT = spotT.m + r.spB / PF;
              r.aT = spotT.m + r.spA / PF;
              r.mT = spotT.m + r.spM / PF;
            }
            // Recompute IY
            const sofTR = sofAt(r.month);
            if (r.dT > 0 && r.mT != null && sMT != null && sofTR != null) {
              r.iyM = implYld(r.mT, sMT, sofTR, r.dT);
              r.iyB = implYld(r.bT, sAT, sofTR, r.dT);
              r.iyA = implYld(r.aT, sBT, sofTR, r.dT);
            }
          }
        }
      }
    }
  }

  const immR = IMM_DATES.filter(im => im.days <= maxT * 31)
    .map(im => getRow(im.days / 30.44, im.days, im.label, im.valDate));

  // Fwd-fwd chain
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = i > 0 ? rows[i - 1] : null;
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
    r.ffSofr = fwdD > 0 && r.sofT != null && p?.sofT != null ? ((1 + r.sofT / 100 * r.dT / 360) / (1 + p.sofT / 100 * p.dT / 360) - 1) * 360 / fwdD * 100 : null;
    r.ffBasis = r.ffIyM != null && r.ffSofr != null ? r.ffIyM - r.ffSofr : null;
    r.ffIyBpD = r.ffIyM != null && fwdD > 0 ? r.ffIyM / 360 * 100 : null;
    r.pipChg = r.spM != null && r.spM1 != null ? r.spM - r.spM1 : null;
    r.ffChg = r.ffM != null && r.ffM1 != null ? r.ffM - r.ffM1 : null;
    r.iyChg = r.iyM != null && r.iyM1 != null ? r.iyM - r.iyM1 : null;
    r.sofChg = r.sofT != null && r.sofT1 != null ? r.sofT - r.sofT1 : null;
    r.basChg = r.basisT != null && r.basisT1 != null ? r.basisT - r.basisT1 : null;
    r.ffIyChg = r.ffIyM != null && r.ffIyM1 != null ? r.ffIyM - r.ffIyM1 : null;
    // Row-level carry / roll-down (spot-start SPxT). Both are static-curve
    // P&L from rolling forward by 1 month (30d):
    //   carryP = fwdPts[T-30] - fwdPts[T]   (in pips)
    //   carryY = IY(SPx(T-30)) - IY(SPxT)   (in % — multiply ×100 for bps)
    // For sub-1M tenors use a 1-day horizon. At month===0 both are undefined.
    if (r.month === 0) { r.carryP = null; r.carryY = null; }
    else if (r.month < 1) {
      // Sub-1M: 1-day roll = pts(days) - pts(days-1)
      const td = r.dT || 0;
      if (td >= 1) {
        const ptsCur = r.spM != null ? r.spM : iPtMT(td);
        const ptsPrev = iPtMT(td - 1);
        r.carryP = (ptsCur != null && ptsPrev != null) ? ptsPrev - ptsCur : null;
        if (sMT != null) {
          const sofCur = sofAt(r.month);
          const sofPrev = sofAt((td - 1) / 30);
          if (ptsCur != null && ptsPrev != null && sofCur != null && sofPrev != null) {
            const iyCur = implYld(sMT + ptsCur / PF, sMT, sofCur, td);
            const iyPrev = td > 1 ? implYld(sMT + ptsPrev / PF, sMT, sofPrev, td - 1) : null;
            r.carryY = (iyCur != null && iyPrev != null) ? iyPrev - iyCur : null;
          } else { r.carryY = null; }
        } else { r.carryY = null; }
      } else { r.carryP = null; r.carryY = null; }
    } else {
      const td = r.dT || 0;
      const shifted = td - 30;
      const ptsShift = shifted <= 0 ? 0 : iPtMT(shifted);
      const ptsF = r.spM != null ? r.spM : iPtMT(td);
      r.carryP = (ptsShift != null && ptsF != null) ? (ptsShift - ptsF) : null;
      if (sMT != null && shifted > 0 && ptsShift != null && r.iyM != null) {
        const sofShift = sofAt(shifted / 30);
        if (sofShift != null) {
          const iyShift = implYld(sMT + ptsShift / PF, sMT, sofShift, shifted);
          r.carryY = iyShift != null ? iyShift - r.iyM : null;
        } else { r.carryY = null; }
      } else { r.carryY = null; }
    }
    // Legacy slope fields kept for back-compat (unused by tables now).
    r.rollP = r.carryP;
    r.rollY = r.carryY;
  }

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

  // Build a virtual row for non-standard labels (ON/TN/SN/1W/TOMFIX/1M+1bd) used by
  // spread-pack specials. Returns a row-shaped dict with spM / iyM / sofT / dT / valDate.
  // Falls back to interpolation on anchor curve if no direct source.
  function virtualRow(labelKey) {
    const key = (labelKey || "").toUpperCase();
    // Funding tenors — prefer the funding snapshot
    if (["ON", "TN", "SN"].includes(key)) {
      const days = { ON: 1, TN: 2, SN: 3 }[key];
      const bundle = snap.funding?.[key];
      const src = bundle?.sources?.composite || (bundle?.sources && Object.values(bundle.sources).find(s => s && s.hasData));
      let spM = null, spB = null, spA = null, spM1 = null, spB1 = null, spA1 = null;
      if (src && src.hasData) {
        const dp = displayPtsFromSource(src, PF);
        spM = dp.m; spB = dp.b; spA = dp.a;
        const dp1 = displayPtsFromSourceT1(src, PF);
        spM1 = dp1.m; spB1 = dp1.b; spA1 = dp1.a;
      }
      // Fallback: interpolate curve at `days`
      if (spM == null) spM = iPtMT(days);
      if (spB == null) spB = iPtBT(days);
      if (spA == null) spA = iPtAT(days);
      if (spM1 == null) spM1 = iPtMT1(days);
      const sof = sofAt(1);
      const sof1 = sofAt1(1);
      const mT = sMT != null && spM != null ? sMT + spM / PF : null;
      const iyM = implYld(mT, sMT, sof, days);
      return {
        month: days / 30, dT: days, dT1: days,
        spM, spB, spA, spM1, spB1, spA1,
        iyM, iyB: iyM, iyA: iyM, iyM1: null,
        sofT: sof, sofT1: sof1,
        valDate: dateFromSpot(SPOT_DATE, days),
        fixDate: null,
      };
    }
    if (key === "1W") {
      const r = rows.find(r => Math.abs(r.month - 0.25) < 1e-6);
      return r || null;
    }
    if (key === "SPOT" || key === "SP") {
      return rows.find(r => r.month === 0);
    }
    if (key === "TOMFIX" || key === "1M+1BD") {
      // TOMFIX = T+1bd. 1M+1bd = standard spot-start 1M forward whose value date
      // is shifted forward by 1 business day. No proper RIC; interpolate from the
      // currently-aggregated curve (auto/manual-mode aware via iPtMT et al.).
      // Prefer backend IPA-derived days (holiday-adjusted); fall back to 1/31.
      const tp = snap.tomfixPlus1bd;
      const d = key === "TOMFIX"
        ? (tp?.nearDays ?? 1)                     // IPA-approx: fallback 1d
        : (tp?.farDays ?? 31);                    // IPA-approx: fallback 31d
      const spM = iPtMT(d); // may be null at very short end if no curve data below 1M
      const spB = iPtBT(d);
      const spA = iPtAT(d);
      const spM1 = iPtMT1(d);
      const spB1 = iPtBT1(d);
      const spA1 = iPtAT1(d);
      const sof = sofAt(d / 30);
      const sof1 = sofAt1(d / 30);
      const mT = sMT != null && spM != null ? sMT + spM / PF : null;
      const iyM = implYld(mT, sMT, sof, d);
      // Issue 7: wire fixing dates from backend tomfixPlus1bd
      const fixDateStr = key === "TOMFIX" ? tp?.nearFixDate : tp?.farFixDate;
      const valDateStr = key === "TOMFIX" ? tp?.nearValueDate : tp?.farValueDate;
      return {
        month: d / 30, dT: d, dT1: d,
        spM: spM ?? 0, spB: spB ?? spM ?? 0, spA: spA ?? spM ?? 0,
        spM1: spM1 ?? 0, spB1: spB1 ?? spM1 ?? 0, spA1: spA1 ?? spM1 ?? 0,
        iyM, iyB: iyM, iyA: iyM, iyM1: null,
        sofT: sof, sofT1: sof1,
        valDate: valDateStr ? new Date(valDateStr) : dateFromSpot(SPOT_DATE, d),
        fixDate: fixDateStr ? new Date(fixDateStr) : null,
      };
    }
    return null;
  }

  // Carry = static-curve P&L over the horizon of the trade.
  //   Spot-start SPxT:       horizon = 1 month (30d). carry = fwdPts_days[T-30] - fwdPts_days[T]
  //                          (for SPx1M → fwdPts[0]-fwdPts[30d] = -fwdPts[30d])
  //   Fwd-fwd NxF (N>0):     horizon = N days (near.days). carry = fwdPts[F-N] - (fwdPts[F]-fwdPts[N])
  // All fwdPts lookups use the aggregated curve via days-indexed iPtMT.
  function computeCarry(nr, fr) {
    if (!nr || !fr) return null;
    const nearDays = nr.dT || 0;
    const farDays = fr.dT || 0;
    if (farDays <= 0) return null;
    const ptsF = fr.spM != null ? fr.spM : iPtMT(farDays);
    if (ptsF == null) return null;
    // Spot-start: 1-month (30-day) roll.
    if (nearDays === 0) {
      const horizon = 30;
      const shifted = farDays - horizon;
      const ptsShift = shifted <= 0 ? 0 : iPtMT(shifted);
      if (ptsShift == null) return null;
      return ptsShift - ptsF;
    }
    // Fwd-fwd: horizon = nearDays.
    const diffDays = farDays - nearDays;
    if (diffDays <= 0) return null;
    const ptsDiff = iPtMT(diffDays);
    const ptsN = nr.spM != null ? nr.spM : iPtMT(nearDays);
    if (ptsDiff == null || ptsN == null) return null;
    return ptsDiff - (ptsF - ptsN);
  }

  // Carry-Y = static-curve change in implied yield (bps as percent) over the
  // same horizon as computeCarry. After rolling forward by `horizon`, the
  // position becomes SPx(F-horizon) outright; new IY is computed from the
  // post-roll outright. Returns iyNew - iyOld in % (multiply by 100 for bps).
  function computeCarryY(nr, fr) {
    if (!nr || !fr || sMT == null) return null;
    const nearDays = nr.dT || 0;
    const farDays = fr.dT || 0;
    if (farDays <= 0) return null;
    const horizon = nearDays === 0 ? 30 : nearDays;
    const newDays = farDays - horizon;
    if (newDays <= 0) return null;
    const newPts = iPtMT(newDays);
    if (newPts == null) return null;
    const sofN = sofAt(newDays / 30);
    if (sofN == null) return null;
    const outN = sMT + newPts / PF;
    const iyNew = implYld(outN, sMT, sofN, newDays);
    if (iyNew == null) return null;
    // Pre-roll yield: spot-start = current outright IY (fr.iyM); fwd-fwd = fwd-fwd IY.
    const iyOld = nearDays === 0 ? fr.iyM : fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    if (iyOld == null) return null;
    return iyNew - iyOld;
  }

  function mkSpr(nrM, frM, label, opts) {
    opts = opts || {};
    let nr = null, fr = null;
    if (opts.nearLabel) nr = virtualRow(opts.nearLabel);
    if (opts.farLabel) fr = virtualRow(opts.farLabel);
    if (!nr) nr = rows.find(r => r.month === nrM);
    if (!fr) fr = rows.find(r => r.month === frM);
    // For special pack rows that need a virtual row that's unavailable (e.g. IPA TOMFIX
    // returned null), emit a placeholder row with no data so the table still shows the label.
    if ((opts.nearLabel || opts.farLabel) && (!nr || !fr)) {
      return {
        label, nrM, frM,
        pB: null, pM: null, pA: null, pB1: null, pM1: null, pA1: null,
        chg: null, days: null,
        nrVD: null, frVD: null, nrFxD: null, frFxD: null,
        nrDT: null, frDT: null,
        fIyB: null, fIy: null, fIyA: null, fIy1: null,
        iyChg: null, fSof: null, fSof1: null, sofChg: null, bas: null, basChg: null,
        ppd: null, carry: null, carryY: null, iyBpD: null,
        nearLabel: opts.nearLabel || null, farLabel: opts.farLabel || null,
        unavailable: true,
        unavailableReason: "data unavailable",
      };
    }
    if (!nr || !fr) return null;
    const haveT = fr.spB != null && fr.spM != null && fr.spA != null && nr.spA != null && nr.spM != null && nr.spB != null;
    const haveT1 = fr.spB1 != null && fr.spM1 != null && fr.spA1 != null && nr.spA1 != null && nr.spM1 != null && nr.spB1 != null;
    const pB = haveT ? fr.spB - nr.spA : null, pM = haveT ? fr.spM - nr.spM : null, pA = haveT ? fr.spA - nr.spB : null;
    const pB1 = haveT1 ? fr.spB1 - nr.spA1 : null, pM1 = haveT1 ? fr.spM1 - nr.spM1 : null, pA1 = haveT1 ? fr.spA1 - nr.spB1 : null;
    const ds = fr.dT - nr.dT;
    const fIyB = fwdFwdIy(nr.iyA, nr.dT, fr.iyB, fr.dT);
    const fIy = fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
    const fIyA = fwdFwdIy(nr.iyB, nr.dT, fr.iyA, fr.dT);
    const fIy1 = fwdFwdIy(nr.iyM1, nr.dT1, fr.iyM1, fr.dT1);
    const haveSof = ds > 0 && fr.sofT != null && nr.sofT != null;
    const haveSof1 = ds > 0 && fr.sofT1 != null && nr.sofT1 != null;
    const fSof = haveSof ? ((1 + fr.sofT / 100 * fr.dT / 360) / (1 + nr.sofT / 100 * nr.dT / 360) - 1) * 360 / ds * 100 : null;
    const fSof1 = haveSof1 ? ((1 + fr.sofT1 / 100 * fr.dT1 / 360) / (1 + nr.sofT1 / 100 * nr.dT1 / 360) - 1) * 360 / ds * 100 : null;
    const bas = fIy != null && fSof != null ? fIy - fSof : null;
    const carry = computeCarry(nr, fr);
    const carryY = computeCarryY(nr, fr);
    return {
      label, nrM, frM, pB, pM, pA, pB1, pM1, pA1, chg: pM != null && pM1 != null ? pM - pM1 : null, days: ds,
      nrVD: nr.valDate, frVD: fr.valDate, nrFxD: nr.fixDate, frFxD: fr.fixDate,
      nrDT: nr.dT, frDT: fr.dT,
      fIyB, fIy, fIyA, fIy1,
      iyChg: fIy != null && fIy1 != null ? fIy - fIy1 : null,
      fSof, fSof1, sofChg: fSof != null && fSof1 != null ? fSof - fSof1 : null,
      bas, basChg: bas != null && fIy1 != null && fSof1 != null ? bas - (fIy1 - fSof1) : null,
      ppd: ds > 0 && pM != null ? pM / ds : null,
      carry, carryY,
      iyBpD: fIy != null ? fIy / 360 * 100 : null,
      nearLabel: opts.nearLabel || null, farLabel: opts.farLabel || null,
    };
  }

  // ── Funding row builder (deliverable ONxTN / TNxSP / SPxSN) ──────────
  // Each row's pts = the dedicated RIC's live value (funding.{ON|TN|SN}).
  // Near/far dates + days come from snap.fundingDates (IPA-resolved).
  function mkFundingRow(def) {
    const label = def.label;
    const farKey = (def.farLabel || "").toUpperCase();
    // Which RIC's value drives this row:
    //   ONxTN → ON  (today→T+1 swap)
    //   TNxSP → TN  (T+1→T+2 swap)
    //   SPxSN → SN  (T+2→T+3 swap)
    const ricKey =
      label === "ONxTN" ? "ON" :
      label === "TNxSP" ? "TN" :
      label === "SPxSN" ? "SN" : farKey;
    const bundle = snap.funding?.[ricKey];
    const src = bundle ? (pickSource(applyLiveToTenor(bundle), selection)
                          || pickSource(applyLiveToTenor(bundle), ["composite"])
                          || (bundle.sources ? pickSource(applyLiveToTenor(bundle), Object.keys(bundle.sources)) : null)) : null;
    let pB = null, pM = null, pA = null, pB1 = null, pM1 = null, pA1 = null;
    let freshness = null, timact = null, ric = null, sourceName = null;
    if (src && src.source) {
      const s = src.source;
      const dpT = displayPtsFromSource(s, PF);
      const dpT1 = displayPtsFromSourceT1(s, PF);
      pB = dpT.b; pM = dpT.m; pA = dpT.a;
      pB1 = dpT1.b; pM1 = dpT1.m; pA1 = dpT1.a;
      freshness = s.freshness; timact = s.timact; ric = s.ric; sourceName = src.name;
    }
    // Dates from IPA (funding bundle resolves to single tenor — use endpoints of the range)
    const fd = snap.fundingDates?.[ricKey] || {};
    const nrVD = fd.startDate ? new Date(fd.startDate) : null;
    const frVD = fd.endDate   ? new Date(fd.endDate)   : null;
    const days = fd.days != null ? fd.days : 1;
    // Carry on funding rows: 1-bd formula using days-indexed curve.
    // horizon = days, carry = iPtMT(max(farDays-days, 0)) - iPtMT(farDays) + spM
    //                     = pts value over the span when rolled back 1 period.
    // Simpler and per spec: use computeCarry on virtual near/far rows.
    const nearDays = days > 0 ? 0 : 0; // funding rows are effectively 1-bd spans
    const farDays = Math.max(days, 1);
    const spotStartLike = label === "TNxSP" ? false : label === "SPxSN" ? false : true;
    // Generic: static-curve 1bd carry = -pts (holding the 1bd position over 1 day).
    const carry = pM != null ? -pM : null;
    return {
      label, nrM: null, frM: null, pB, pM, pA, pB1, pM1, pA1,
      chg: pM != null && pM1 != null ? pM - pM1 : null,
      days,
      nrVD, frVD, nrFxD: null, frFxD: null,
      nrDT: 0, frDT: farDays,
      fIyB: null, fIy: null, fIyA: null, fIy1: null,
      iyChg: null, fSof: null, fSof1: null, sofChg: null, bas: null, basChg: null,
      ppd: days > 0 && pM != null ? pM / days : null,
      carry, carryY: null,
      iyBpD: null,
      nearLabel: def.nearLabel || null, farLabel: def.farLabel || null,
      isFunding: true, fundingTenor: ricKey,
      source: sourceName, freshness, timact, ric,
    };
  }

  // Build named spread packs from backend snap.spreadPacks. New nested shape:
  //   { fullCurve: {spotStart, m1Chain, m3Chain},
  //     spreadsRolls: {interbankAnchors?, imm} }
  // Each pack = array of row-shaped entries compatible with SprTbl.
  function mkRowForDef(def) {
    // Funding rows: near/far are tenor-code strings (e.g. "ON","TN","SP","SN").
    if (typeof def.near === "string") {
      return mkFundingRow(def);
    }
    return mkSpr(def.near, def.far, def.label, { nearLabel: def.nearLabel, farLabel: def.farLabel });
  }
  function buildGroup(group) {
    const out = {};
    for (const [packKey, defs] of Object.entries(group || {})) {
      const arr = [];
      for (const def of defs) {
        const row = mkRowForDef(def);
        if (row) arr.push(row);
      }
      out[packKey] = arr;
    }
    return out;
  }
  const packsIn = snap.spreadPacks || {};
  // Support both new nested shape AND the legacy flat shape {interbankAnchors, m1Chain,...}
  const isNested = packsIn && (packsIn.fullCurve || packsIn.spreadsRolls);
  let spreadPacks;
  if (isNested) {
    spreadPacks = {
      fullCurve:    buildGroup(packsIn.fullCurve),
      spreadsRolls: buildGroup(packsIn.spreadsRolls),
    };
    // Flat mirror (back-compat with any older consumers).
    for (const [k, v] of Object.entries(spreadPacks.fullCurve || {})) spreadPacks[k] = v;
    for (const [k, v] of Object.entries(spreadPacks.spreadsRolls || {})) spreadPacks[k] = v;
  } else {
    spreadPacks = buildGroup(packsIn);
    spreadPacks.fullCurve = {
      spotStart: spreadPacks.spotStart || spreadPacks.interbankAnchors || [],
      m1Chain:   spreadPacks.m1Chain   || [],
      m3Chain:   spreadPacks.m3Chain   || [],
    };
    spreadPacks.spreadsRolls = {
      interbankAnchors: spreadPacks.interbankAnchors || [],
      imm: [],
    };
  }

  // Resolve spread pack from snapshot.spreadDefs (backend is source of truth).
  // Falls back to legacy hardcoded sets when spreadDefs is missing.
  const spreadDefs = snap.spreadDefs || [];
  function mkFromDef(def) {
    return mkSpr(def.near, def.far, def.label, { nearLabel: def.nearLabel, farLabel: def.farLabel });
  }

  let anchors, qFF, spSpr;
  if (spreadDefs.length > 0) {
    // Drive from backend pack. Split into anchors (spot-start / SPx*) and fwd-fwd rolls.
    const isSpotStart = def => def.near === 0 || def.nearLabel === "Spot";
    anchors = [];
    qFF = [];
    for (const def of spreadDefs) {
      const s = mkFromDef(def);
      if (!s) continue;
      if (isSpotStart(def)) anchors.push(s);
      else qFF.push(s);
    }
    // For NDF, also compute 3M rolling fwd-fwd extras not in backend pack.
    // Ensure 3Mx6M, 3Mx9M, 3Mx12M are available for the 3M FwdFwd chain table.
    if (snap.spreadPack === "NDF") {
      const extras = [[3,6,"3Mx6M"],[3,9,"3Mx9M"],[3,12,"3Mx12M"]];
      for (const [n,f,lbl] of extras) {
        if (f <= maxT && !qFF.find(x => x.label === lbl)) {
          const s = mkSpr(n, f, lbl);
          if (s) qFF.push(s);
        }
      }
      for (let n = 6; n <= 21; n += 3) {
        const f = n + 3;
        if (f <= maxT) {
          const lbl = `${n}M×${f <= 12 ? f+"M" : f===24 ? "2Y" : f+"M"}`;
          if (!qFF.find(x => x.label === lbl)) {
            const s = mkSpr(n, f, lbl);
            if (s) qFF.push(s);
          }
        }
      }
    }
  } else if (snap.spreadPack === "NDF") {
    const anchorDefs = [[1,2,"1Mx2M"],[1,3,"1Mx3M"],[1,6,"1Mx6M"],[1,9,"1Mx9M"],[1,12,"1Mx12M"],[12,18,"12Mx18M"],[12,24,"12Mx2Y"]];
    anchors = anchorDefs.filter(([n,f]) => f <= maxT && n <= maxT).map(([n,f,l]) => mkSpr(n,f,l)).filter(Boolean);
    qFF = [];
    for (let n = 3; n <= 21; n += 3) {
      const f = n + 3;
      if (f <= maxT) { const s = mkSpr(n, f, `${n}M×${f <= 12 ? f+"M" : f===24 ? "2Y" : f+"M"}`); if (s) qFF.push(s); }
    }
  } else {
    anchors = [];
    for (const m of [1,2,3,6,9,12,18,24]) {
      if (m <= maxT) { const s = mkSpr(0, m, `SPx${m<=12?m+"M":"2Y"}`); if (s) anchors.push(s); }
    }
    qFF = [];
    const fwdFwdDefs = [[1,2,"1Mx2M"],[2,3,"2Mx3M"],[3,6,"3Mx6M"],[6,9,"6Mx9M"],[9,12,"9Mx12M"],[12,18,"12Mx18M"],[18,24,"18Mx24M"]];
    for (const [n,f,l] of fwdFwdDefs) { if (f <= maxT) { const s = mkSpr(n,f,l); if (s) qFF.push(s); } }
  }
  // spSpr: spot-start against each anchor tenor — keep the hardcoded set (it's a second
  // "spot-start spreads" panel that users expect to have 1M/2M/.../2Y).
  spSpr = [1,2,3,6,9,12,18,24].filter(f => f <= maxT).map(f => mkSpr(0, f, `SP×${f<=12?f+"M":"2Y"}`)).filter(Boolean);

  // Dedupe by label across anchor-set union (e.g. THB produced duplicate SPx2Y rows).
  const seen = new Set();
  anchors = anchors.filter(s => (s && !seen.has(s.label)) ? seen.add(s.label) : false);
  const seenSp = new Set();
  spSpr = spSpr.filter(s => (s && !seenSp.has(s.label)) ? seenSp.add(s.label) : false);

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
      carry: computeCarry(nr, fr),
      carryY: computeCarryY(nr, fr),
      iyBpD: fIy != null ? fIy / 360 * 100 : null,
    });
  }

  // Funding: keep per-source bundle so UI can render ON/TN/SN × per-source table.
  // Also provide flattened T/T1 (first selected picked) for backward compat.
  const fundingOut = {};
  for (const [tenorKey, bundle] of Object.entries(snap.funding || {})) {
    const t = applyLiveToTenor(bundle);
    const picked = pickSource(t, selection) || pickSource(t, ["composite"]) || (t.sources ? pickSource(t, Object.keys(t.sources)) : null);
    const bySource = {};
    for (const [name, s] of Object.entries(t.sources || {})) {
      if (!s) { bySource[name] = null; continue; }
      const dpT = displayPtsFromSource(s, PF);
      const dpT1 = displayPtsFromSourceT1(s, PF);
      bySource[name] = {
        hasData: !!s.hasData,
        T: { bid: dpT.b, ask: dpT.a, mid: dpT.m },
        T1: { bid: dpT1.b, ask: dpT1.a, mid: dpT1.m },
        freshness: s.freshness, timact: s.timact, ageSec: s.ageSec, ric: s.ric,
      };
    }
    if (!picked) {
      fundingOut[tenorKey] = { T: {}, T1: {}, bySource, hasAnyData: !!bundle.hasAnyData };
      continue;
    }
    const s = picked.source;
    const dpT = displayPtsFromSource(s, PF);
    const dpT1 = displayPtsFromSourceT1(s, PF);
    fundingOut[tenorKey] = {
      T: { bid: dpT.b, ask: dpT.a, mid: dpT.m },
      T1: { bid: dpT1.b, ask: dpT1.a, mid: dpT1.m },
      source: picked.name,
      freshness: s.freshness,
      bySource,
      hasAnyData: !!bundle.hasAnyData,
    };
  }

  const cfg = {
    pair: snap.pair, pipFactor: PF, dp, pipDp, kind: snap.kind,
    spreadPack: snap.spreadPack, ptsInOutright: snap.ptsInOutright || false,
    deriveFromOutrights,
    brokers: snap.brokers || [],
    brokersMeta: snap.brokersMeta || {},
    freshnessThresholdsSec: snap.freshnessThresholdsSec || { fresh: 600, stale: 3600 },
    valueMode: snap.valueMode,
  };
  // Categorize fwd-fwd rolls for the per-table layout:
  //   ff1M:      rows with near===1 (1M FwdFwd chain)
  //   ff3M:      rows with near===3 (3M FwdFwd chain)
  //   ibAnchor:  everything else in qFF + non-spot anchors in `anchors`
  //              For deliverables: also include funding spot-start (SPxON/TN/SN/1W).
  const ff1M = qFF.filter(s => s && s.nrM === 1);
  const ff3M = qFF.filter(s => s && s.nrM === 3);
  const ff1MLabels = new Set(ff1M.map(s => s.label));
  const ff3MLabels = new Set(ff3M.map(s => s.label));
  const ibAnchor = [];
  for (const s of qFF) {
    if (!s) continue;
    if (ff1MLabels.has(s.label) || ff3MLabels.has(s.label)) continue;
    ibAnchor.push(s);
  }
  // Deliverable funding spot-start spreads (SPxON/TN/SN/1W) come from `anchors` (near=0).
  if (!isNDF) {
    for (const s of anchors) {
      if (!s) continue;
      const nl = (s.nearLabel || "").toUpperCase();
      const fl = (s.farLabel  || "").toUpperCase();
      if (["ON","TN","SN","1W"].includes(fl) || ["ON","TN","SN","1W"].includes(nl)) {
        ibAnchor.unshift(s);
      }
    }
  }

  return {
    rows, immR, anchors, qFF, spSpr, immSpr, funding: fundingOut,
    ff1M, ff3M, ibAnchor,
    spreadPacks,
    sMT, sMT1, sBT, sAT, cfg, ccy: snap.ccy, maxT,
    SPOT_DATE, TENOR_DATES,
    lastReloadTs: snap.lastReloadTs,
    selection,
  };
}

export function calcCustom(ad, nearM, farM, nearDate, farDate, ipaCustom) {
  const { rows, SPOT_DATE } = ad;
  let nM = nearM, fM = farM, nVD = null, fVD = null;
  if (nearDate) { nM = daysBtwn(SPOT_DATE, nearDate) / 30.44; nVD = nearDate; }
  if (farDate) { fM = daysBtwn(SPOT_DATE, farDate) / 30.44; fVD = farDate; }
  if (fM <= nM) return null;

  // Issue 2: Snap to anchor tenor when custom dates land within 1 calendar day
  // of an existing anchor tenor's value date. This avoids discrepancies between
  // the custom IPA/interp path and the live aggregated source.
  function snapToAnchor(date, monthApprox) {
    if (!date) return null;
    for (const r of rows) {
      if (r.month === 0) continue;
      if (!r.valDate) continue;
      const vd = r.valDate instanceof Date ? r.valDate : new Date(r.valDate);
      if (Math.abs(daysBtwn(date, vd)) <= 1) return r;
    }
    return null;
  }
  if (nearDate && farDate) {
    const snapNr = snapToAnchor(nearDate, nM);
    const snapFr = snapToAnchor(farDate, fM);
    if (snapNr && snapFr && snapNr !== snapFr) {
      // Both legs match anchors — use live aggregated values directly
      const pM = snapFr.spM != null && snapNr.spM != null ? snapFr.spM - snapNr.spM : null;
      const pB = snapFr.spB != null && snapNr.spA != null ? snapFr.spB - snapNr.spA : null;
      const pA = snapFr.spA != null && snapNr.spB != null ? snapFr.spA - snapNr.spB : null;
      const ds = snapFr.dT - snapNr.dT;
      const fIy = fwdFwdIy(snapNr.iyM, snapNr.dT, snapFr.iyM, snapFr.dT);
      return {
        label: `${fD(nearDate)} × ${fD(farDate)}`,
        pB, pM, pA, days: ds, fIy,
        nrVD: snapNr.valDate, frVD: snapFr.valDate,
        nrFxD: snapNr.fixDate, frFxD: snapFr.fixDate,
        nrDT: snapNr.dT, frDT: snapFr.dT,
        source: "snapped",
        ppd: ds > 0 && pM != null ? pM / ds : null,
      };
    }
  }

  if (ipaCustom && ipaCustom.near && ipaCustom.far) {
    const ipaN = ipaCustom.near, ipaF = ipaCustom.far;
    const nPts = ipaN.fwdPoints, fPts = ipaF.fwdPoints;
    const nDays = ipaN.days, fDays = ipaF.days;
    if (nPts != null && fPts != null && nDays != null && fDays != null) {
      const pM = fPts - nPts;
      const nrI = Math.floor(nM), frI = Math.floor(fM);
      const mT = ad.maxT || 24;
      const nrRow = nrI >= 0 && nrI <= mT ? rows.find(r => r.month === nrI) : null;
      const frRow = frI >= 0 && frI <= mT ? rows.find(r => r.month === frI) : null;
      const nrHalf = nrRow && nrRow.spB != null && nrRow.spA != null ? (nrRow.spA - nrRow.spB) / 2 : 0;
      const frHalf = frRow && frRow.spB != null && frRow.spA != null ? (frRow.spA - frRow.spB) / 2 : 0;
      const pB = (fPts - frHalf) - (nPts + nrHalf);
      const pA = (fPts + frHalf) - (nPts - nrHalf);
      const ds = fDays - nDays;
      const nIy = ipaN.impliedYield, fIy_raw = ipaF.impliedYield;
      const fIy = nIy != null && fIy_raw != null ? fwdFwdIy(nIy, nDays, fIy_raw, fDays) : null;
      const parseD = (s) => s ? new Date(s) : null;
      return {
        label: `${nearDate ? fD(nearDate) : `${Math.floor(nM)}M`} × ${farDate ? fD(farDate) : `${Math.floor(fM)}M`}`,
        pB, pM, pA, days: ds, fIy,
        nrVD: parseD(ipaN.valueDate) || nVD, frVD: parseD(ipaF.valueDate) || fVD,
        nrFxD: parseD(ipaN.fixDate), frFxD: parseD(ipaF.fixDate),
        nrDT: nDays, frDT: fDays,
        source: "IPA",
        ppd: ds > 0 && pM != null ? pM / ds : null,
      };
    }
  }

  const nrI = Math.floor(nM), frI = Math.floor(fM);
  const mT = ad.maxT || 24;
  const nr = nrI >= 0 && nrI <= mT ? rows.find(r => r.month === nrI) : null;
  const fr = frI >= 0 && frI <= mT ? rows.find(r => r.month === frI) : null;
  if (!nr || !fr) return null;
  // Spot-start (near=spot): pts of spread = pts of far outright (spot has no
  // swap pts), and the fwd-fwd IY collapses to the far leg's outright IY.
  // Without this case both pM and fIy become null whenever the user picks
  // Spot as the near leg in Tools.
  const isSpotNear = nr.month === 0;
  const nrSpM = isSpotNear ? 0 : nr.spM;
  const nrSpB = isSpotNear ? 0 : nr.spB;
  const nrSpA = isSpotNear ? 0 : nr.spA;
  const pM = fr.spM != null && nrSpM != null ? fr.spM - nrSpM : null;
  const pB = fr.spB != null && nrSpA != null ? fr.spB - nrSpA : null;
  const pA = fr.spA != null && nrSpB != null ? fr.spA - nrSpB : null;
  const ds = fr.dT - nr.dT;
  const fIy = isSpotNear ? fr.iyM : fwdFwdIy(nr.iyM, nr.dT, fr.iyM, fr.dT);
  return {
    label: `${nearDate ? fD(nearDate) : `${nrI}M`} × ${farDate ? fD(farDate) : `${frI}M`}`,
    pB, pM, pA, days: ds, fIy,
    nrVD: nVD || nr.valDate, frVD: fVD || fr.valDate,
    nrFxD: nr.fixDate, frFxD: fr.fixDate,
    nrDT: nr.dT, frDT: fr.dT,
    source: "interp",
    ppd: ds > 0 && pM != null ? pM / ds : null,
  };
}
