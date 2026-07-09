// Clean-vs-dirty FX swap-point curve bootstrap.
//
// MODEL.
//   pts_dirty(d) = pts_clean(d) + Σ δ_i  for all turn-dates t_i in (spot, d]
//
//   • d is days from spot.
//   • δ_i is the magnitude (in pip units) that turn t_i adds to every
//     forward whose value date is at or after t_i.
//   • pts_clean(d) is the smooth term structure of swap points in absence
//     of any turn; we model it as a monotone-cubic interpolation through
//     unknown anchor values c_1..c_n (one per anchor tenor).
//
// SOLVE (Tikhonov-regularized least squares — CONSTRAINED so turns can't eat
// the curve's natural convexity):
//   Unknowns x = [c_1, ..., c_n, δ_1, ..., δ_f]  (n clean + f FREE turns)
//   Anchor equations:  y_i = c_i + Σ δ_j · 1(t_j ≤ d_i)     (n equations)
//   Smoothness penalty on clean curve — THIRD difference (curvature-of-
//   curvature / 2nd derivative of the forward), NOT second difference:
//                      μ · Δ³c = 0                          (n - 3 rows)
//     A 3rd divided difference vanishes for any quadratic, so the base curve
//     may be CONVEX at zero cost but pays for changing convexity (wiggle).
//     (A 2nd-difference penalty forbids convexity, which forced the turns to
//     absorb it — the bug this replaces: +5 → +18 pip.)
//   Turn prior — L1 (lasso) via IRLS + tiny L2 floor, centered at 0:
//                      penalty = λ₁·|δ_j| + λ₂·δ_j²          (f rows)
//     A turn survives only if a genuine step in the anchors demands it; small
//     turns are driven to 0 while real ones are barely biased (unlike a flat
//     L2 ridge, which shrinks true turns proportionally).
//   Gate: a turn's step column is fixed by the first anchor that spans it;
//     turns sharing that span-start anchor are collinear (only their sum is
//     identifiable), so we free at most one per span-start (the dominant type)
//     and fix the rest to δ=0.
//
//   Solve the augmented system via normal equations + LU. Plain JS, no deps.
//
// SIGN CONVENTION (per LSEG / industry).
//   δ > 0 means the turn ADDS to swap pts (the typical USD-funding-squeeze
//   direction at year-end: USD becomes scarcer over the turn day, pushing the
//   USD-implied 1d rate higher, which lifts FX swap pts on USDxxx pairs).
//   We always report δ in pips AND in implied yield bps for trader scanning.

import { mcI, implYld } from "./calc.js";

// Tikhonov weights — tuned via synthetic recovery tests on realistically
// CONVEX true clean curves with 0–3 injected turns.
//   SMOOTH_W  weights a spacing-aware THIRD divided difference of the clean
//             anchors (normalized so its coefficients are O(1), ≈ (1/6)·
//             [-1,3,-3,1] on a uniform grid). It kills wiggle but leaves
//             convexity free, so turns no longer absorb the curve's curvature.
//   TURN_L1   lasso weight on turn sizes (via IRLS): the dominant, near-
//             unbiased term. Large enough that a spurious sub-pip step dies,
//             small enough that a genuine 5-pip turn is recovered to <15%.
//   TURN_L2   tiny L2 floor for numerical conditioning of the turn block.
//   TURN_EPS  IRLS denominator floor (pips); turns below ~this collapse to 0.
const SMOOTH_W        = 4.0;
const TURN_L1         = 0.03;
const TURN_L2         = 0.01;
const TURN_EPS        = 0.05;
const TURN_IRLS_ITERS = 10;
const TURN_PRIORITY   = { YE: 4, LUNAR: 3, QE: 2, ME: 1 };

// ── Solve A x = b via normal equations: (AᵀA) x = Aᵀb. Plain partial-pivot
// LU on a dense system (≤ ~50 unknowns in the worst case here, fast enough).
function _solveNormal(A, b) {
  const m = A.length, n = A[0].length;
  // AtA = AᵀA  (n×n);  Atb = Aᵀb  (n)
  const AtA = Array.from({length:n}, () => new Float64Array(n));
  const Atb = new Float64Array(n);
  for (let r = 0; r < m; r++) {
    const row = A[r], br = b[r];
    for (let i = 0; i < n; i++) {
      const v = row[i]; if (v === 0) continue;
      Atb[i] += v * br;
      for (let j = 0; j < n; j++) AtA[i][j] += v * row[j];
    }
  }
  // Gaussian elimination with partial pivot
  const M = AtA.map(r => Array.from(r));
  const y = Array.from(Atb);
  for (let i = 0; i < n; i++) {
    let p = i, best = Math.abs(M[i][i]);
    for (let k = i+1; k < n; k++) { const v = Math.abs(M[k][i]); if (v > best) { best = v; p = k; } }
    if (best < 1e-14) return null;
    if (p !== i) { [M[i], M[p]] = [M[p], M[i]]; [y[i], y[p]] = [y[p], y[i]]; }
    const pv = M[i][i];
    for (let k = i+1; k < n; k++) {
      const f = M[k][i] / pv; if (f === 0) continue;
      for (let j = i; j < n; j++) M[k][j] -= f * M[i][j];
      y[k] -= f * y[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n-1; i >= 0; i--) {
    let s = y[i];
    for (let j = i+1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

// ── parse "YYYY-MM-DD" → Date (UTC noon — avoid TZ edge cases when
// computing day diffs against SPOT_DATE).
function _isoToDate(iso) {
  if (iso instanceof Date) return iso;
  if (!iso || typeof iso !== "string") return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y) return null;
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

// ── days from spot to a date (clamped non-negative).
function _daysFrom(spot, date) {
  if (!spot || !date) return null;
  return Math.round((date - spot) / 86400000);
}

/**
 * Bootstrap the clean swap-point curve and per-turn deltas.
 *
 * @param {Object} params
 * @param {Array<{days:number, pts:number}>} params.anchors  Dirty pts at each anchor tenor (days from spot).
 * @param {Array<{date:string, type:string, label:string}>} params.turns  Calendar turns from backend.
 * @param {Date} params.spotDate  Spot value date (anchors days are computed from this).
 * @param {number} params.spot    Spot mid (for IY conversion).
 * @param {number} params.pipFactor  Currency pip factor.
 * @param {Function} [params.sofAt]  Optional SOFR(months) interpolator for IY conversion.
 *
 * @returns {{
 *   cleanCurve: Function,   // d (days) → clean pts
 *   anchorClean: Array<{days, dirty, clean, diff}>,
 *   deltas: Array<{date, type, label, days, deltaPts, deltaBps}>,
 *   ok: boolean
 * } | null}
 */
export function bootstrapCleanCurve({ anchors, turns, spotDate, spot, pipFactor, sofAt }) {
  if (!anchors || !anchors.length || !spotDate) return null;
  // Filter to anchors with valid dirty pts. Prepend a synthetic spot anchor
  // (d=0, pts=0): without this, turns whose date lies before the first real
  // anchor are perfectly collinear with shifting the entire clean curve up
  // and become unidentifiable. Spot pts is by definition 0 on both clean
  // and dirty curves, so this is exact, not an assumption.
  const real = anchors.filter(a => a && a.pts != null && isFinite(a.pts) && a.days > 0)
                      .sort((p, q) => p.days - q.days);
  if (real.length < 2) return null;
  const A = [{ tenor: "Spot", month: 0, days: 0, pts: 0, _synthetic: true }, ...real];

  // Filter turns to only those within the anchor span (anything outside our
  // longest anchor cannot be inferred from the data).
  const maxDays = A[A.length - 1].days;
  const T = (turns || [])
    .map(t => ({ ...t, days: _daysFrom(spotDate, _isoToDate(t.date)) }))
    .filter(t => t.days != null && t.days > 0 && t.days <= maxDays)
    .sort((p, q) => p.days - q.days);
  const n = A.length, k = T.length;

  // ── Turn identifiability gate ──────────────────────────────────────────────
  // A turn's step column in the anchor system is fully determined by the index
  // of the FIRST anchor that spans it (days ≥ turn day): the column is 1 there
  // and for every later anchor, 0 before. Two turns sharing that span-start
  // anchor have identical columns → perfectly collinear, so only their SUM is
  // identifiable from anchor data. We therefore free at most one turn per
  // span-start bucket (the economically dominant one by type; ties → earliest),
  // and require a genuine non-spanning anchor below it (guaranteed by the
  // synthetic spot anchor at day 0). Every other turn is fixed to δ=0.
  const spanStart = new Array(k);
  for (let j = 0; j < k; j++) {
    let s = n;                                     // sentinel: nothing spans it
    for (let i = 0; i < n; i++) { if (A[i].days >= T[j].days) { s = i; break; } }
    spanStart[j] = s;
  }
  const bestBySpan = new Map();                     // span-start idx → turn idx
  for (let j = 0; j < k; j++) {
    const s = spanStart[j];
    if (s <= 0 || s >= n) continue;                 // no bracket ⇒ unidentifiable
    const cur = bestBySpan.get(s);
    if (cur == null) { bestBySpan.set(s, j); continue; }
    const pc = TURN_PRIORITY[T[cur].type] || 0;
    const pj = TURN_PRIORITY[T[j].type]   || 0;
    if (pj > pc || (pj === pc && T[j].days < T[cur].days)) bestBySpan.set(s, j);
  }
  const isFree = new Array(k).fill(false);
  for (const j of bestBySpan.values()) isFree[j] = true;
  const free = [];
  for (let j = 0; j < k; j++) if (isFree[j]) free.push(j);
  const f = free.length, nUnk = n + f;

  // Build the FIXED part of the augmented system (rebuilt turn prior each IRLS
  // pass). Unknowns: x = [c_1..c_n, δ_free_1..δ_free_f].
  const baseRows = [];
  const baseRhs  = [];

  // (1) Anchor equations: y_i = c_i + Σ_free δ · 1(t ≤ d_i)
  for (let i = 0; i < n; i++) {
    const r = new Float64Array(nUnk);
    r[i] = 1;
    for (let p = 0; p < f; p++) if (T[free[p]].days <= A[i].days) r[n + p] = 1;
    baseRows.push(r);
    baseRhs.push(A[i].pts);
  }

  // (2) Smoothness — THIRD divided difference (spacing-aware) so the base curve
  // may be convex at zero cost but pays for CHANGING convexity (wiggle). The
  // 3rd divided difference vanishes for any quadratic; normalized by mean
  // spacing³ so coefficients are O(1) (≈ (1/6)[-1,3,-3,1] on a uniform grid),
  // comparable to the anchor equations.
  if (n >= 4) {
    for (let s = 0; s + 3 < n; s++) {
      const xi = [A[s].days, A[s+1].days, A[s+2].days, A[s+3].days];
      const hbar = (xi[3] - xi[0]) / 3;
      if (!(hbar > 0)) continue;
      const norm = hbar * hbar * hbar;
      const r = new Float64Array(nUnk);
      let ok = true;
      for (let m = 0; m < 4; m++) {
        let denom = 1;
        for (let q = 0; q < 4; q++) if (q !== m) denom *= (xi[m] - xi[q]);
        if (denom === 0) { ok = false; break; }
        r[s + m] = SMOOTH_W * norm / denom;
      }
      if (ok) { baseRows.push(r); baseRhs.push(0); }
    }
  } else if (n >= 3) {
    // Fallback for <4 anchors (can't form a 4-point 3rd difference): a light,
    // spacing-aware 2nd difference just to keep the system well-posed.
    for (let i = 1; i < n - 1; i++) {
      const dL = A[i].days - A[i-1].days || 1;
      const dR = A[i+1].days - A[i].days || 1;
      const dM = Math.max(dL, dR);
      const r = new Float64Array(nUnk);
      r[i-1] = -SMOOTH_W * (dM / dL);
      r[i]   =  SMOOTH_W * dM * (1/dL + 1/dR);
      r[i+1] = -SMOOTH_W * (dM / dR);
      baseRows.push(r); baseRhs.push(0);
    }
  }

  // (3) Turn prior — L1 (lasso) via IRLS + tiny L2 floor, centered at 0. Each
  // pass appends one ridge row per free turn with weight w_p; the L1 weight is
  // reweighted by 1/|δ_p| so the penalty behaves like λ₁·Σ|δ| (sparse, nearly
  // unbiased for large turns) rather than an L2 ridge (shrinks all turns).
  const solveWith = (weights) => {
    const rows = baseRows.slice();
    const rhs  = baseRhs.slice();
    for (let p = 0; p < f; p++) {
      const r = new Float64Array(nUnk);
      r[n + p] = weights[p];
      rows.push(r); rhs.push(0);
    }
    return _solveNormal(rows, rhs);
  };
  const delta = new Float64Array(f);
  let x;
  if (f > 0) {
    // Init with the L2 floor only (unbiased-ish), then IRLS-reweight for L1.
    x = solveWith(new Float64Array(f).fill(Math.sqrt(TURN_L2)));
    if (!x) return null;
    for (let p = 0; p < f; p++) delta[p] = x[n + p];
    for (let it = 0; it < TURN_IRLS_ITERS; it++) {
      const w = new Float64Array(f);
      for (let p = 0; p < f; p++)
        w[p] = Math.sqrt(TURN_L1 / (Math.abs(delta[p]) + TURN_EPS) + TURN_L2);
      const xn = solveWith(w);
      if (!xn) break;
      x = xn;
      for (let p = 0; p < f; p++) delta[p] = x[n + p];
    }
  } else {
    x = solveWith(new Float64Array(0));
    if (!x) return null;
  }

  const cleanAnchors = x.slice(0, n);
  const deltaPts = new Array(k).fill(0);
  for (let p = 0; p < f; p++) deltaPts[free[p]] = delta[p];
  const xs = A.map(a => a.days);
  const cleanCurve = mcI(xs, cleanAnchors);

  // Convert pip deltas to implied-yield bps for trader scanning.
  // δ_bps ≈ (δ_pts / pipFactor / spot) × (360 / 1) × 1e4 — i.e. the additional
  // 1d implied yield from a one-pip pts shift over the turn.
  function toBps(dPts) {
    if (spot == null || pipFactor == null || !isFinite(spot) || spot <= 0) return null;
    return (dPts / pipFactor / spot) * 360 * 1e4;
  }

  const deltas = T.map((t, j) => ({
    date: t.date,
    type: t.type,
    label: t.label,
    days: t.days,
    deltaPts: deltaPts[j],
    deltaBps: toBps(deltaPts[j]),
  }));

  const anchorClean = A.map((a, i) => ({
    days: a.days,
    tenor: a.tenor,
    dirty: a.pts,
    clean: cleanAnchors[i],
    diff:  a.pts - cleanAnchors[i],
  }));

  return { cleanCurve, anchorClean, deltas, ok: true, spotDate, pipFactor };
}

/**
 * For a given fwd-fwd spread (near→far), compute its dirty / clean / diff
 * using the bootstrapped result. Diff > 0 ⇒ spread is paying you to hold the
 * turn risk it spans (rich); Diff < 0 ⇒ spread is paying premium to be
 * turn-protected (cheap).
 */
export function spreadRichness(spread, boot) {
  if (!spread || !boot) return null;
  const nrVD = _isoToDate(spread.nrVD);
  const frVD = _isoToDate(spread.frVD);
  if (!nrVD || !frVD) return null;
  const nDays = _daysFrom(boot.spotDate, nrVD);
  const fDays = _daysFrom(boot.spotDate, frVD);
  if (nDays == null || fDays == null || fDays <= nDays) return null;

  const cleanFar  = boot.cleanCurve(fDays);
  const cleanNear = nDays === 0 ? 0 : boot.cleanCurve(nDays);
  if (cleanFar == null || cleanNear == null) return null;
  const cleanSpread = cleanFar - cleanNear;
  const dirty = spread.pM;
  if (dirty == null) return null;

  // Identify which turns this spread spans
  const turnsIn = (boot.deltas || []).filter(d => d.days > nDays && d.days <= fDays);
  return {
    label: spread.label,
    nDays, fDays,
    dirty,
    clean: cleanSpread,
    diff: dirty - cleanSpread,
    turns: turnsIn,
  };
}
