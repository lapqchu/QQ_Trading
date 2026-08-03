// SGD NEER — Analysis tab. Consumes /api/neer/sgd/analysis (mean-reversion
// signal model + backtest). Self-contained: own theme + formatters so it can
// be compiled / reasoned about independently of NeerApp.jsx.
import React, { useEffect, useState, useCallback } from "react";
import Plot from "react-plotly.js";
import { F, FP } from "../calc.js";

// ── Dark theme (mirrors NeerApp) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

const num = (v, dp = 3) => F(v, dp);
const sgn = (v, dp = 1) => FP(v, dp);
const scol = (v) => (v == null || !isFinite(v)) ? C.dim
  : v > 0.0001 ? C.up2 : v < -0.0001 ? C.down : C.dim;

const PLAYOUT = {
  paper_bgcolor: C.panel, plot_bgcolor: C.panel2,
  font: { color: C.sub, size: 9, family: "Inter,system-ui" },
  margin: { l: 46, r: 16, t: 40, b: 26 },
  xaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true, type: "date" },
  yaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true },
  hovermode: "x unified",
  legend: { font: { size: 8 }, bgcolor: "transparent", orientation: "h", x: 0, y: 1.16 },
  uirevision: "keep",   // preserve pan/zoom across refreshes
};
const PCFG = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage", "autoScale2d"],
};

// ── Building blocks ──
function Panel({ title, note, right, children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, gap: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: C.sub, textTransform: "uppercase" }}>{title}</div>
        {right}
      </div>
      {children}
      {note && <div style={{ fontSize: 8.5, color: C.dim, marginTop: 6, fontStyle: "italic", lineHeight: 1.4 }}>{note}</div>}
    </div>
  );
}

function Stat({ label, value, sub, color, tip }) {
  return (
    <div title={tip} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 9px", minWidth: 0 }}>
      <div style={{ fontSize: 8, fontWeight: 700, color: C.dim, letterSpacing: ".05em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 700, color: color || C.text, marginTop: 2, lineHeight: 1.1 }}>{value}</div>
      {sub != null && <div style={{ fontFamily: C.mono, fontSize: 9, color: C.sub, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── A. Band position mean-reversion signal chart ──
function SignalChart({ a }) {
  const dates = a?.dates || [];
  const bb = a?.bollinger || {};
  const sigs = Array.isArray(a?.signals) ? a.signals : [];
  const buys = sigs.filter((s) => s.type === "buy");
  const sells = sigs.filter((s) => s.type === "sell");
  const traces = [
    { x: dates, y: bb.upper, name: `Upper +${bb.k ?? 2}σ`, type: "scatter", mode: "lines", line: { color: C.down, width: 1, dash: "dot" }, hoverinfo: "skip" },
    { x: dates, y: bb.lower, name: `Lower −${bb.k ?? 2}σ`, type: "scatter", mode: "lines", line: { color: C.up2, width: 1, dash: "dot" }, fill: "tonexty", fillcolor: "rgba(59,130,246,0.05)", hoverinfo: "skip" },
    { x: dates, y: bb.sma, name: `SMA(${bb.n ?? 20})`, type: "scatter", mode: "lines", line: { color: C.sub, width: 1, dash: "dash" } },
    { x: dates, y: a?.devPct, name: "Band pos %", type: "scatter", mode: "lines", line: { color: C.cyan, width: 1.6 } },
    { x: buys.map((s) => s.date), y: buys.map((s) => s.dev), name: "BUY", type: "scatter", mode: "markers", marker: { symbol: "triangle-up", size: 10, color: C.up, line: { width: 0.5, color: "#052e16" } }, hovertemplate: "BUY %{x}<br>dev %{y:.3f}<extra></extra>" },
    { x: sells.map((s) => s.date), y: sells.map((s) => s.dev), name: "SELL", type: "scatter", mode: "markers", marker: { symbol: "triangle-down", size: 10, color: C.down, line: { width: 0.5, color: "#450a0a" } }, hovertemplate: "SELL %{x}<br>dev %{y:.3f}<extra></extra>" },
  ];
  const layout = {
    ...PLAYOUT, height: 320,
    title: { text: "Band Position — Mean Reversion (Bollinger + signals)", font: { size: 11, color: C.text }, x: 0.01, y: 0.99 },
    yaxis: { ...PLAYOUT.yaxis, ticksuffix: "%" },
  };
  return <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
}

// ── B. Trend overlay ──
function TrendChart({ a }) {
  const dates = a?.dates || [];
  const tr = a?.trend || {};
  const traces = [
    { x: dates, y: a?.devPct, name: "Band pos %", type: "scatter", mode: "lines", line: { color: C.dim, width: 1 } },
    { x: dates, y: tr.sma20, name: "SMA20", type: "scatter", mode: "lines", line: { color: C.cyan, width: 1.5 } },
    { x: dates, y: tr.sma50, name: "SMA50", type: "scatter", mode: "lines", line: { color: C.amber, width: 1.5 } },
  ];
  const layout = {
    ...PLAYOUT, height: 240,
    title: { text: "Trend — SMA20 vs SMA50", font: { size: 11, color: C.text }, x: 0.01, y: 0.98 },
    yaxis: { ...PLAYOUT.yaxis, ticksuffix: "%" },
  };
  return <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
}

// ── C. Equity curve ──
function EquityChart({ a }) {
  const dates = a?.dates || [];
  const bt = a?.backtest || {};
  const traces = [{
    x: dates, y: bt.equity, name: "Equity", type: "scatter", mode: "lines",
    line: { color: C.up2, width: 1.6 }, fill: "tozeroy", fillcolor: "rgba(52,211,153,0.06)",
    hovertemplate: "%{x}<br>%{y:.4f}<extra></extra>",
  }];
  const layout = {
    ...PLAYOUT, height: 210, legend: undefined,
    title: { text: "Equity Curve", font: { size: 11, color: C.text }, x: 0.01, y: 0.98 },
  };
  return <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
}

// ── C. Rolling Sharpe ──
function SharpeChart({ a }) {
  const dates = a?.dates || [];
  const bt = a?.backtest || {};
  const traces = [{
    x: dates, y: bt.rollingSharpe, name: "Rolling Sharpe", type: "scatter", mode: "lines",
    line: { color: C.cyan, width: 1.4 }, hovertemplate: "%{x}<br>%{y:.2f}<extra></extra>",
  }];
  const layout = {
    ...PLAYOUT, height: 210, legend: undefined,
    title: { text: "Rolling Sharpe (60d)", font: { size: 11, color: C.text }, x: 0.01, y: 0.98 },
    shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 0, y1: 0, line: { color: "#475569", width: 1, dash: "dot" } }],
  };
  return <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
}

// ── Main ──
export default function NeerAnalysis() {
  const [a, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/neer/sgd/analysis");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setA(j); setErr(null);
    } catch (e) {
      setErr(e?.message || "analysis unavailable");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);   // fetch once on tab open

  const bt = a?.backtest || {};
  const gridStyle = { display: "grid", gap: 12 };
  const refreshBtn = (
    <button onClick={load} disabled={loading} style={{
      fontSize: 9, fontWeight: 700, color: loading ? C.dim : C.cyan, background: "transparent",
      border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 10px",
      cursor: loading ? "default" : "pointer", letterSpacing: ".05em",
    }}>{loading ? "…" : "REFRESH"}</button>
  );

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: ".06em", color: C.text }}>MEAN-REVERSION ANALYSIS</div>
        {refreshBtn}
      </div>

      {err && (
        <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(248,113,113,0.10)", border: `1px solid ${C.down}55`, color: C.down, fontSize: 10.5, fontWeight: 600 }}>
          ⚠ Analysis feed unavailable — {err}. {a ? "Showing last good data." : "Press REFRESH to retry."}
        </div>
      )}

      {!a ? (
        <div style={{ color: C.dim, fontSize: 11, padding: "80px 0", textAlign: "center" }}>{loading ? "loading analysis…" : "no analysis data"}</div>
      ) : (
        <>
          {/* A. signal chart */}
          <Panel title="Band Position — Mean Reversion" note="Band position % detrended vs the crawling midpoint; Bollinger bands + fade signals overlaid.">
            <SignalChart a={a} />
          </Panel>

          {/* B. trend overlay */}
          <div style={{ marginTop: 12 }}>
            <Panel title="Trend">
              <TrendChart a={a} />
            </Panel>
          </div>

          {/* C. backtest */}
          <div style={{ marginTop: 12 }}>
            <Panel title="Backtest" note={bt.strategy || null}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 8, marginBottom: 10 }}>
                <Stat label="Total Return" value={`${num(bt.totalReturnPct, 2)}%`} color={scol(bt.totalReturnPct)} tip="Cumulative strategy return over the window" />
                <Stat label="Ann Return" value={`${num(bt.annReturnPct, 2)}%`} color={scol(bt.annReturnPct)} tip="Annualised strategy return" />
                <Stat label="Sharpe" value={num(bt.sharpe, 2)} color={C.cyan} tip="Annualised Sharpe ratio" />
                <Stat label="Max Drawdown" value={`${num(bt.maxDrawdownPct, 2)}%`} color={C.down} tip="Worst peak-to-trough decline" />
                <Stat label="Hit Rate" value={`${num(bt.hitRatePct, 1)}%`} tip="Share of profitable trades" />
                <Stat label="# Signals" value={num(bt.nSignals, 0)} tip="Number of entry signals generated" />
              </div>
              <div style={{ ...gridStyle, gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
                <EquityChart a={a} />
                <SharpeChart a={a} />
              </div>
            </Panel>
          </div>

          {/* D. caveat */}
          <div style={{ marginTop: 12, fontSize: 8.5, color: C.dim, fontStyle: "italic", lineHeight: 1.5, textAlign: "center" }}>
            Model-estimated: band width, slope and midpoint are reverse-engineered estimates — MAS does not disclose the exact policy-band parameters.
            Signals and backtest are illustrative of the mean-reversion edge, not investment advice.
          </div>
        </>
      )}
    </div>
  );
}
