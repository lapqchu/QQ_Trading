// Quant utilities — full port from v1
// Interpolation, implied yields, stats, indicators, strategies

// ── Monotone cubic Hermite (Fritsch-Carlson) ──
export function mcI(xs, ys) {
  const n = xs.length;
  if (n < 2) return () => (ys[0] ?? null);
  const dx = new Array(n - 1), dy = new Array(n - 1), slope = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; dy[i] = ys[i + 1] - ys[i]; slope[i] = dy[i] / dx[i]; }
  const m = new Array(n);
  m[0] = slope[0]; m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else { const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1]; m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]); }
  }
  return function interp(x) {
    if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = dx[i], t = (x - xs[i]) / h;
    return (1 + 2 * t) * (1 - t) ** 2 * ys[i] + t * (1 - t) ** 2 * h * m[i] + t * t * (3 - 2 * t) * ys[i + 1] + t * t * (t - 1) * h * m[i + 1];
  };
}

export const mid = (b, a) => (b != null && a != null ? (b + a) / 2 : null);

export function implYld(fwd, spot, sofr, days) {
  if (fwd == null || spot == null || sofr == null || !days) return null;
  const sofrDisc = 1 + (sofr / 100) * days / 360;
  return ((fwd / spot) * sofrDisc - 1) * 360 / days * 100;
}

export function fwdFwdIy(iyN, dN, iyF, dF) {
  if (iyN == null || iyF == null || !dN || !dF || dF <= dN) return null;
  return ((1 + (iyF / 100) * dF / 360) / (1 + (iyN / 100) * dN / 360) - 1) * 360 / (dF - dN) * 100;
}

// ── Formatting ──
export const F = (v, dp = 3) => v != null ? v.toFixed(dp) : "—";
export const FP = (v, dp = 1) => { if (v == null) return "—"; const s = v.toFixed(dp); return v > 0.0001 ? `+${s}` : s; };
export const CC = v => { if (v == null || Math.abs(v) < 0.001) return "#64748B"; return v > 0 ? "#F87171" : "#4ADE80"; };
export function HB(val, mx, pos = [59, 130, 246], neg = [244, 114, 182]) {
  if (val == null || Math.abs(val) < 0.0005) return "transparent";
  const t = Math.min(Math.abs(val) / (mx || 1), 1);
  const c = val > 0 ? pos : neg;
  return `rgba(${c[0]},${c[1]},${c[2]},${.08 + t * .5})`;
}

// ── Cell / table styles ──
export const cS = (color, bold, border, bg) => ({
  padding: "3px 4px", fontSize: 9, color: color || "#CBD5E1",
  fontFamily: "'JetBrains Mono','Fira Code',monospace", fontWeight: bold ? 700 : 400,
  textAlign: "right", borderRight: border ? "1px solid #1E293B" : "none",
  background: bg || "transparent", whiteSpace: "nowrap",
});
export const tS = (color) => ({
  padding: "2px 4px", fontSize: 7, fontWeight: 800, color: color || "#64748B",
  textAlign: "right", position: "sticky", top: 0, background: "#0F172A", zIndex: 2,
  borderBottom: "2px solid #334155", whiteSpace: "nowrap", letterSpacing: ".04em", textTransform: "uppercase",
});
export const sS = (color) => ({
  padding: "1px 3px", fontSize: 6, fontWeight: 900, color, textAlign: "center",
  position: "sticky", top: 0, zIndex: 3, background: "#0F172A", borderBottom: "1px solid #334155",
  letterSpacing: ".1em", textTransform: "uppercase", borderLeft: "1px solid #1E293B",
});

// ── Historical stats helpers ──
export function genHist(val, n = 252) {
  const v = .002, d = new Array(n); d[n - 1] = val;
  for (let i = n - 2; i >= 0; i--) d[i] = d[i + 1] * (1 - v * ((Math.random() - .5) * 3));
  const pts = []; const end = new Date(); let dt = new Date(end);
  for (let i = n - 1; i >= 0; i--) { pts.unshift({ date: new Date(dt), value: d[i] }); dt.setDate(dt.getDate() - 1); while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() - 1); }
  return pts;
}
export function calcSMA(d, p) { const r = []; for (let i = 0; i < d.length; i++) { if (i < p - 1) { r.push(null); continue; } let s = 0; for (let j = i - p + 1; j <= i; j++) s += d[j].value; r.push(s / p); } return r; }
export function calcEMA(d, p) { const k = 2 / (p + 1), r = [d[0].value]; for (let i = 1; i < d.length; i++) r.push(d[i].value * k + r[i - 1] * (1 - k)); return r; }
export function calcRSI(d, p = 14) { const r = [null]; for (let i = 1; i < d.length; i++) { const ch = []; for (let j = Math.max(1, i - p + 1); j <= i; j++) ch.push(d[j].value - d[j - 1].value); const g = ch.filter(c => c > 0).reduce((a, b) => a + b, 0) / p; const l = Math.abs(ch.filter(c => c < 0).reduce((a, b) => a + b, 0)) / p; r.push(l === 0 ? 100 : 100 - 100 / (1 + g / l)); } return r; }
export function calcBB(d, p = 20, mult = 2) { const mi = calcSMA(d, p), u = [], lo = []; for (let i = 0; i < d.length; i++) { if (mi[i] == null) { u.push(null); lo.push(null); continue; } let ss = 0; for (let j = i - p + 1; j <= i; j++) ss += (d[j].value - mi[i]) ** 2; const sd = Math.sqrt(ss / p); u.push(mi[i] + mult * sd); lo.push(mi[i] - mult * sd); } return { mid: mi, upper: u, lower: lo }; }
export function calcMACD(d) { const e12 = calcEMA(d, 12), e26 = calcEMA(d, 26); const line = e12.map((v, i) => v - e26[i]); const sd = line.map((v, i) => ({ value: v, date: d[i].date })); const sig = calcEMA(sd, 9); const hist = line.map((v, i) => v - sig[i]); return { line, signal: sig, hist }; }

export function calcStats(h, sigN = 20) {
  const vals = h.map(x => x.value); const n = vals.length; const cur = vals[n - 1];
  const mean = vals.reduce((a, b) => a + b) / n;
  const v = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n; const sd = Math.sqrt(v);
  const sk = vals.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
  const kt = vals.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n - 3;
  const sorted = [...vals].sort((a, b) => a - b);
  const pctR = sorted.filter(x => x <= cur).length / n * 100;
  const ranges = {};
  for (const [k, d] of [["1W", 5], ["2W", 10], ["1M", 22], ["3M", 66], ["6M", 132], ["1Y", 252]]) {
    const sl = vals.slice(Math.max(0, n - d));
    ranges[k] = { low: Math.min(...sl), high: Math.max(...sl) };
  }
  // Sigma-move
  let dayChg = null, rollSd = null, sigmaMove = null;
  if (n >= sigN + 2) {
    const deltas = []; for (let i = 1; i < n; i++) deltas.push(vals[i] - vals[i - 1]);
    dayChg = deltas[deltas.length - 1];
    const slice = deltas.slice(-sigN - 1, -1);
    const mn = slice.reduce((a, b) => a + b, 0) / slice.length;
    const vr = slice.reduce((a, b) => a + (b - mn) ** 2, 0) / slice.length;
    rollSd = Math.sqrt(vr);
    sigmaMove = rollSd > 0 ? dayChg / rollSd : null;
  }
  // SMA / deviation / z-score
  let smaN = null, devMA = null, zDev = null;
  if (n >= sigN) {
    let s = 0; for (let j = n - sigN; j < n; j++) s += vals[j]; smaN = s / sigN;
    devMA = cur - smaN;
    let ss = 0; for (let j = n - sigN; j < n; j++) ss += (vals[j] - smaN) ** 2;
    const sdN = Math.sqrt(ss / sigN);
    zDev = sdN > 0 ? devMA / sdN : null;
  }
  return { current: cur, mean, sd, skew: sk, kurt: kt, pctR, ranges, sigmaMove, dayChg, rollSd, devMA, zDev, smaN, sigN };
}

export function calcZDev(d, p = 20) {
  const r = new Array(d.length).fill(null);
  for (let i = p - 1; i < d.length; i++) {
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += d[j].value;
    const m = s / p; let ss = 0; for (let j = i - p + 1; j <= i; j++) ss += (d[j].value - m) ** 2;
    const sd = Math.sqrt(ss / p); r[i] = sd > 0 ? (d[i].value - m) / sd : null;
  }
  return r;
}

// ── Strategies + backtest ──
export const STRAT_DESCS = {
  "Mean Rev(20)": "Fade z-score of deviation from 20d SMA. Short when z>2, long when z<-2, exit at 0.",
  "SMA Cross(20/50)": "Long when SMA20 > SMA50, short when SMA20 < SMA50.",
  "BB Revert(20,2)": "Fade Bollinger Band extremes: sell at upper, buy at lower, exit at middle.",
  "RSI(14) Fade": "Buy when RSI dips below 30, sell when RSI rises above 70.",
  "Z-Score Mean Rev(20)": "Fade z-score extremes past ±2σ. Same as Mean Rev(20) logic.",
};

export function backtest(hist, lookbackDays) {
  const strats = [
    { name: "Mean Rev(20)", fn: meanRevStrategy },
    { name: "SMA Cross(20/50)", fn: smaCrossStrategy },
    { name: "BB Revert(20,2)", fn: bbRevertStrategy },
    { name: "RSI(14) Fade", fn: rsiFadeStrategy },
    { name: "Z-Score Mean Rev(20)", fn: zScoreMeanRevStrategy },
  ];
  const data = hist.slice(-lookbackDays);
  return strats.map(s => {
    try {
      const signals = s.fn(data);
      if (!signals || signals.length < 2) return { name: s.name, unavail: true, reason: "Not enough data" };
      return runBacktest(s.name, data, signals);
    } catch (e) { return { name: s.name, unavail: true, reason: e.message }; }
  });
}
function meanRevStrategy(d) { const z = calcZDev(d, 20); return z.map(v => v == null ? 0 : (v > 2 ? -1 : v < -2 ? 1 : 0)); }
function zScoreMeanRevStrategy(d) { const z = calcZDev(d, 20); return z.map(v => v == null ? 0 : (v > 2 ? -1 : v < -2 ? 1 : 0)); }
function smaCrossStrategy(d) { const s20 = calcSMA(d, 20), s50 = calcSMA(d, 50); return d.map((_, i) => s20[i] == null || s50[i] == null ? 0 : (s20[i] > s50[i] ? 1 : -1)); }
function bbRevertStrategy(d) { const bb = calcBB(d, 20, 2); return d.map((v, i) => bb.upper[i] == null ? 0 : (v.value > bb.upper[i] ? -1 : v.value < bb.lower[i] ? 1 : 0)); }
function rsiFadeStrategy(d) { const rsi = calcRSI(d, 14); return rsi.map(v => v == null ? 0 : (v > 70 ? -1 : v < 30 ? 1 : 0)); }

function runBacktest(name, data, signals) {
  const n = data.length; const dates = data.map(d => d.date); const rets = [];
  for (let i = 1; i < n; i++) { const r = (data[i].value - data[i - 1].value) / data[i - 1].value; rets.push(signals[i - 1] * r); }
  const eqC = [1]; for (let i = 0; i < rets.length; i++) eqC.push(eqC[i] * (1 + rets[i]));
  const cumRet = eqC[eqC.length - 1] - 1; let peak = 1, maxDD = 0;
  for (let i = 0; i < eqC.length; i++) { if (eqC[i] > peak) peak = eqC[i]; const dd = (eqC[i] - peak) / peak; if (dd < maxDD) maxDD = dd; }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const wins = rets.filter(r => r > 0).length; const winRate = rets.length > 0 ? wins / rets.length : 0;
  // Rolling sharpe
  const rollSh = []; for (let i = 0; i < rets.length; i++) {
    if (i < 19) { rollSh.push(null); continue; }
    const sl = rets.slice(i - 19, i + 1); const m = sl.reduce((a, b) => a + b, 0) / 20;
    const s = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
    rollSh.push(s > 0 ? (m / s) * Math.sqrt(252) : 0);
  }
  return { name, sharpe, cumRet, maxDD: Math.abs(maxDD), winRate, eqC, dates: dates.slice(1), rollSh };
}
