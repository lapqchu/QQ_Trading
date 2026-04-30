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
// SOLVE (Tikhonov-regularized least squares):
//   Unknowns x = [c_1, ..., c_n, δ_1, ..., δ_k]  (n + k unknowns)
//   Anchor equations:  y_i = c_i + Σ δ_j · 1(t_j ≤ d_i)     (n equations)
//   Smoothness penalty on clean curve (second-difference of c):
//                      μ · (c_{i-1} - 2 c_i + c_{i+1}) = 0  (n - 2 rows)
//   Ridge on δ: prefer small turn magnitudes when data is ambiguous:
//                      λ · δ_j = 0                          (k rows)
//
//   Solve the augmented system via normal equations + LU. Plain JS, no deps.
//
// SIGN CONVENTION (per LSEG / industry).
//   δ > 0 means the turn ADDS to swap pts (the typical USD-funding-squeeze
//   direction at year-end: USD becomes scarcer over the turn day, pushing the
//   USD-implied 1d rate higher, which lifts FX swap pts on USDxxx pairs).
//   We always report δ in pips AND in implied yield bps for trader scanning.

import { mcI, implYld } from "./calc.js";

// Tikhonov weights — tuned via synthetic recovery tests across linear,
// concave, and convex true clean curves with 2–3 turns. SMOOTH_W applied to
// a spacing-aware second-difference normalized so coefficients are O(1) and
// comparable to anchor-fit equations. SMOOTH_W=0.5 is the sweet spot:
// stronger values over-smooth real curve curvature and bias δ upward; weaker
// values let curve kinks absorb the turn jump (δ recovery degrades). At 0.5,
// linear+2turn recovers δ within 0.01 pips; concave+3turn within ~0.5 pips.
// RIDGE_W kept tiny so δ magnitudes are data-driven, not regularized to 0.
const SMOOTH_W = 0.5;
const RIDGE_W  = 0.01;

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

  // Build augmented LSQ system. Unknowns: x = [c_1..c_n, δ_1..δ_k].
  // Row groups: (1) anchor obs, (2) smoothness penalty on c, (3) ridge on δ.
  const rows = [];
  const rhs  = [];

  // (1) Anchor equations
  for (let i = 0; i < n; i++) {
    const r = new Float64Array(n + k);
    r[i] = 1;
    for (let j = 0; j < k; j++) if (T[j].days <= A[i].days) r[n + j] = 1;
    rows.push(r);
    rhs.push(A[i].pts);
  }

  // (2) Smoothness on clean curve: discrete second difference at anchor scale.
  // Coefficients are O(1) (not 1/dL-scaled) so smoothness has comparable
  // weight to anchor-fit. Spacing-aware via the standard 3-point formula
  // for non-uniform grids, but normalized by the larger segment so the
  // coefficient on c_i stays O(1).
  for (let i = 1; i < n - 1; i++) {
    const r = new Float64Array(n + k);
    const dL = A[i].days - A[i-1].days || 1;
    const dR = A[i+1].days - A[i].days || 1;
    const dM = Math.max(dL, dR);
    const w  = SMOOTH_W;
    // -dM/dL c_{i-1} + dM*(1/dL + 1/dR) c_i - dM/dR c_{i+1}, scaled by w
    r[i-1] = -w * (dM / dL);
    r[i]   =  w * dM * (1/dL + 1/dR);
    r[i+1] = -w * (dM / dR);
    rows.push(r);
    rhs.push(0);
  }

  // (3) Ridge on δ — prefer small magnitudes when the system is ambiguous.
  for (let j = 0; j < k; j++) {
    const r = new Float64Array(n + k);
    r[n + j] = RIDGE_W;
    rows.push(r);
    rhs.push(0);
  }

  const x = _solveNormal(rows, rhs);
  if (!x) return null;

  const cleanAnchors = x.slice(0, n);
  const deltaPts = x.slice(n);
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
