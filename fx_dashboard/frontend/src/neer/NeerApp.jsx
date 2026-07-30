// SGD NEER deep-dive monitor — separate page from the FX pricer.
// Consumes the live backend at /api/neer/sgd (+ /history, /calibration).
import React, { useEffect, useState, useCallback } from "react";
import Plot from "react-plotly.js";
import { F, FP } from "../calc.js";
import NeerAnalysis from "./NeerAnalysis.jsx";

// ── Dark theme (mirrors the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

// ── Formatting helpers ──
const num = (v, dp = 3) => F(v, dp);          // null-safe fixed → "—"
const sgn = (v, dp = 1) => FP(v, dp);         // signed, "—" on null
// Sign colour with theme direction: green up, red down, dim on ~0.
const scol = (v) => (v == null || !isFinite(v)) ? C.dim
  : v > 0.0001 ? C.up2 : v < -0.0001 ? C.down : C.dim;
// Adaptive quote/rate formatter for wide-magnitude FX quotes.
const qfmt = (v) => {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 100) return v.toFixed(2);
  if (a >= 10) return v.toFixed(3);
  return v.toFixed(4);
};
const pctW = (v) => (v == null || !isFinite(v)) ? "—" : v.toFixed(2);
const fmtAsof = (iso) => {
  if (!iso) return "—";
  return String(iso).replace("T", "  ").slice(0, 19);
};

// ── Plotly layout defaults (module scope so charts don't remount on tick) ──
const PLAYOUT = {
  paper_bgcolor: C.panel, plot_bgcolor: C.panel2,
  font: { color: C.sub, size: 9, family: "Inter,system-ui" },
  margin: { l: 46, r: 16, t: 26, b: 26 },
  xaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true },
  yaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true },
  hovermode: "x unified",
  legend: { font: { size: 8 }, bgcolor: "transparent", orientation: "h", x: 0, y: 1.14 },
};
const PCFG = { responsive: true, displayModeBar: false, displaylogo: false };
const PCFG_BAR = {
  responsive: true, displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage", "autoScale2d"],
};

// ── Small building blocks ──
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

// ── Section 2: band position gauge ──
function BandGauge({ neer, metrics }) {
  const width = neer?.widthBp, pos = neer?.posBp;
  if (width == null || pos == null || !width) {
    return <div style={{ color: C.dim, fontSize: 11, padding: "18px 0", textAlign: "center" }}>band data unavailable</div>;
  }
  const pct = Math.max(0, Math.min(1, (pos + width) / (2 * width))) * 100;
  const ratio = pos / width; // -1 floor .. +1 ceiling
  const mColor = ratio >= 0.66 ? C.down : ratio >= 0.25 ? C.amber
    : ratio > -0.25 ? C.cyan : ratio > -0.66 ? C.up2 : C.up;
  const rich = ratio >= 0.25 ? "RICH" : ratio <= -0.25 ? "CHEAP" : "NEUTRAL";
  const toCeil = metrics?.toCeilingBp, toFloor = metrics?.toFloorBp;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.sub, marginBottom: 5, fontFamily: C.mono }}>
        <span><span style={{ color: C.up }}>FLOOR</span> −{num(width, 0)}bp · {num(toFloor, 0)}bp away</span>
        <span style={{ color: C.dim }}>MIDPOINT {num(neer?.midpoint, 3)}</span>
        <span>{num(toCeil, 0)}bp away · <span style={{ color: C.down }}>CEILING</span> +{num(width, 0)}bp</span>
      </div>
      <div style={{ position: "relative", height: 40, marginTop: 16 }}>
        {/* track */}
        <div style={{
          position: "absolute", top: 12, left: 0, right: 0, height: 16, borderRadius: 8,
          background: `linear-gradient(90deg, rgba(74,222,128,0.30), rgba(52,211,153,0.14) 34%, rgba(34,211,238,0.10) 50%, rgba(251,191,36,0.22) 78%, rgba(248,113,113,0.34))`,
          border: `1px solid ${C.border}`,
        }} />
        {/* midpoint tick */}
        <div style={{ position: "absolute", top: 8, left: "50%", width: 2, height: 24, marginLeft: -1, background: "#475569" }} />
        {/* marker */}
        <div style={{ position: "absolute", top: 2, left: `${pct}%`, transform: "translateX(-50%)", textAlign: "center", transition: "left .4s ease" }}>
          <div style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 800, color: mColor, whiteSpace: "nowrap" }}>{sgn(pos, 0)}bp</div>
          <div style={{ width: 0, height: 0, margin: "1px auto 0", borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: `8px solid ${mColor}` }} />
          <div style={{ width: 3, height: 20, margin: "0 auto", background: mColor, borderRadius: 2, boxShadow: `0 0 6px ${mColor}` }} />
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".12em", color: mColor, border: `1px solid ${mColor}55`, borderRadius: 4, padding: "2px 10px" }}>{rich}</span>
      </div>
    </div>
  );
}

// ── Section 3: band history chart with MAS meeting annotations ──
// action → colour: ease green, tighten red, recentre blue, hold grey.
const ACTION_COLOR = { ease: C.up, tighten: C.down, recentre: C.blue, hold: C.dim };
function HistoryChart({ hist, meetingActions }) {
  const dates = hist?.dates || [];
  if (!dates.length) {
    return <div style={{ color: C.dim, fontSize: 11, padding: "120px 0", textAlign: "center" }}>history unavailable</div>;
  }
  const traces = [
    { x: dates, y: hist.lower, name: "Lower band", type: "scatter", mode: "lines", line: { color: C.down, width: 1, dash: "dot" }, hoverinfo: "skip" },
    { x: dates, y: hist.upper, name: "Upper band", type: "scatter", mode: "lines", line: { color: C.up2, width: 1, dash: "dot" }, fill: "tonexty", fillcolor: "rgba(59,130,246,0.06)", hoverinfo: "skip" },
    { x: dates, y: hist.midpoint, name: "Midpoint", type: "scatter", mode: "lines", line: { color: C.sub, width: 1, dash: "dash" } },
    { x: dates, y: hist.neer, name: "NEER", type: "scatter", mode: "lines", line: { color: C.cyan, width: 2 } },
  ];
  // Prefer rich meeting actions (date/action/label); fall back to plain meeting dates.
  const acts = (Array.isArray(meetingActions) && meetingActions.length)
    ? meetingActions
    : (hist.meetings || []).map((d) => ({ date: d, action: "hold", label: "" }));
  const shapes = acts.map((m) => ({
    type: "line", x0: m.date, x1: m.date, y0: 0, y1: 1, yref: "paper",
    line: { color: ACTION_COLOR[m.action] || C.dim, width: 1.2, dash: "dash" },
  }));
  const annotations = acts.filter((m) => m.label).map((m) => ({
    x: m.date, y: 1, xref: "x", yref: "paper", text: m.label,
    showarrow: false, textangle: -38, xanchor: "left", yanchor: "bottom",
    font: { size: 7, color: ACTION_COLOR[m.action] || C.dim },
    bgcolor: "rgba(11,18,32,0.55)",
  }));
  const layout = {
    ...PLAYOUT, height: 320, shapes, annotations,
    title: { text: "SGD NEER vs Policy Band — MAS meeting actions", font: { size: 11, color: C.text }, x: 0.01, y: 0.995 },
    margin: { l: 48, r: 16, t: 58, b: 26 },
  };
  return <Plot data={traces} layout={layout} config={PCFG_BAR} style={{ width: "100%" }} useResizeHandler />;
}

// ── Section 4: live intraday chart (self-contained: own window state + 15s poll) ──
const INTRADAY_WINDOWS = [["1d", "1D"], ["3d", "3D"], ["5d", "5D"], ["20d", "20D"]];
function IntradayPanel() {
  const [win, setWin] = useState("1d");
  const [d, setD] = useState(null);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch(`/api/neer/sgd/intraday?window=${win}`);
        if (!r.ok) throw new Error();
        const j = await r.json();
        if (alive) { setD(j); setStale(false); }
      } catch { if (alive) setStale(true); }
    }
    poll();
    const id = setInterval(poll, 15000);   // live feel — refresh every 15s
    return () => { alive = false; clearInterval(id); };
  }, [win]);

  const times = d?.times || [];
  const hasData = times.length > 0;
  const last = hasData ? d.neer[d.neer.length - 1] : null;
  const btns = (
    <div style={{ display: "flex", gap: 4 }}>
      {INTRADAY_WINDOWS.map(([w, lbl]) => (
        <button key={w} onClick={() => setWin(w)} style={{
          fontSize: 8.5, fontWeight: 700, padding: "2px 9px", borderRadius: 4, cursor: "pointer",
          border: `1px solid ${win === w ? C.cyan : C.border}`,
          background: win === w ? "rgba(34,211,238,0.12)" : "transparent",
          color: win === w ? C.cyan : C.sub, letterSpacing: ".05em",
        }}>{lbl}</button>
      ))}
    </div>
  );

  let body;
  if (!hasData) {
    body = <div style={{ color: C.dim, fontSize: 11, padding: "90px 0", textAlign: "center" }}>{stale ? "intraday feed unavailable" : "loading intraday…"}</div>;
  } else {
    const ys = (d.neer || []).filter((v) => v != null && isFinite(v));
    const dataMin = ys.length ? Math.min(...ys) : 0, dataMax = ys.length ? Math.max(...ys) : 1;
    const inRange = [d.midpoint, d.upper].filter((v) => v != null && isFinite(v));
    const rLo = Math.min(dataMin, ...inRange), rHi = Math.max(dataMax, ...inRange);
    const pad = (rHi - rLo) * 0.06 || 0.05;
    const refLine = (y, col) => (y == null || !isFinite(y)) ? null : ({
      type: "line", xref: "paper", x0: 0, x1: 1, y0: y, y1: y, line: { color: col, width: 1, dash: "dash" },
    });
    const shapes = [refLine(d.upper, C.down), refLine(d.midpoint, C.sub), refLine(d.lower, C.up)].filter(Boolean);
    const traces = [{
      x: times, y: d.neer, type: "scatter", mode: "lines", name: "S$NEER",
      line: { color: C.cyan, width: 1.4 }, hovertemplate: "%{x}<br>%{y:.4f}<extra></extra>",
    }];
    const layout = {
      ...PLAYOUT, height: 240, shapes, legend: undefined,
      title: { text: `Intraday S$NEER (${String(d.window || win).toUpperCase()})`, font: { size: 11, color: C.text }, x: 0.01, y: 0.98 },
      margin: { l: 48, r: 16, t: 30, b: 30 },
      xaxis: { ...PLAYOUT.xaxis, type: "date" },
      yaxis: { ...PLAYOUT.yaxis, range: [rLo - pad, rHi + pad] },
    };
    body = <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
  }
  return (
    <Panel title="Live Intraday"
      right={<div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.cyan }}>{num(last, 3)}</span>
        {btns}
      </div>}
      note={hasData ? `${d.interval || ""} bars · ${d.count ?? times.length} pts · ceiling ${num(d.upper, 2)} / mid ${num(d.midpoint, 2)} / floor ${num(d.lower, 2)} · polls 15s` : null}>
      {body}
    </Panel>
  );
}

// ── Section 5: SORA / OIS panel ──
function SoraPanel({ sora }) {
  const curve = Array.isArray(sora?.oisCurve) ? sora.oisCurve : [];
  return (
    <Panel title="SORA / OIS" note="O/N SORA OIS swap vs published O/N fixing; full OIS term structure O/N → 30Y.">
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <Stat label="O/N SORA OIS" value={num(sora?.onSoraOis, 3)} sub={sora?.onOisRic || "%"} color={C.cyan} tip="Overnight SORA OIS swap rate" />
        <Stat label="O/N SORA fixing" value={num(sora?.onSoraFixing, 4)} sub={sora?.onFixingRic || "%"} tip="Published overnight SORA fixing" />
      </div>
      <div style={{ fontSize: 8, fontWeight: 800, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 2 }}>SORA OIS Curve (O/N–30Y)</div>
      <SoraCurveChart curve={curve} />
      {curve.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(56px,1fr))", gap: 4, marginTop: 6 }}>
          {curve.map((p) => (
            <div key={p.label} title={p.ric || ""} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 5px" }}>
              <div style={{ fontSize: 7.5, fontWeight: 700, color: C.dim }}>{p.label}</div>
              <div style={{ fontFamily: C.mono, fontSize: 10, color: C.text }}>{num(p.rate, 3)}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Section 6: carry panel ──
function CarryPanel({ carry }) {
  const tenors = Array.isArray(carry?.tenors) ? carry.tenors : [];
  const byTenor = (t) => tenors.find((x) => x.tenor === t);
  const t3m = byTenor("3M"), t1y = byTenor("1Y");
  const th = { padding: "3px 6px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: `2px solid #334155`, whiteSpace: "nowrap" };
  const td = { padding: "3px 6px", fontSize: 9.5, fontFamily: C.mono, color: C.text, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
  return (
    <Panel title="Carry" note="Carry = forward NEER − spot NEER; net = policy slope − forward-priced appreciation (negative ⇒ costs carry to be long).">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(96px,1fr))", gap: 8, marginBottom: 8 }}>
        <Stat label="Policy slope" value={sgn(carry?.slope, 2)} sub="%/yr" color={C.cyan} tip="MAS appreciation slope of the band midpoint" />
        <Stat label="NET carry 3M" value={sgn(t3m?.netAnnPct, 2)} sub="%/yr" color={scol(t3m?.netAnnPct)} tip="3M net carry: slope − forward-priced appreciation" />
        <Stat label="NET carry 1Y" value={sgn(t1y?.netAnnPct, 2)} sub="%/yr" color={scol(t1y?.netAnnPct)} tip="1Y net carry: slope − forward-priced appreciation" />
      </div>
      {tenors.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>TENOR</th>
                <th style={{ ...th, textAlign: "right" }}>CARRY pts</th>
                <th style={{ ...th, textAlign: "right" }}>FWD−SPOT %</th>
                <th style={{ ...th, textAlign: "right" }}>ANN %</th>
                <th style={{ ...th, textAlign: "right" }}>NET %/yr</th>
              </tr>
            </thead>
            <tbody>
              {tenors.map((t) => (
                <tr key={t.tenor}>
                  <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>{t.tenor}</td>
                  <td style={{ ...td, textAlign: "right", color: C.sub }}>{num(t.carryPts, 3)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{sgn(t.fwdVsSpotPct, 3)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{sgn(t.annPct, 3)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700, color: scol(t.netAnnPct) }}>{sgn(t.netAnnPct, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: C.dim, fontStyle: "italic" }}>carry data unavailable</div>
      )}
    </Panel>
  );
}

// ── Section 5 mini: SORA OIS curve ──
function SoraCurveChart({ curve }) {
  const c = Array.isArray(curve) ? curve : [];
  if (!c.length) return <div style={{ color: C.dim, fontSize: 10, padding: "40px 0", textAlign: "center" }}>curve unavailable</div>;
  const traces = [{
    x: c.map((p) => p.label), y: c.map((p) => p.rate),
    type: "scatter", mode: "lines+markers",
    line: { color: C.cyan, width: 1.5 }, marker: { size: 4, color: C.blue },
    hovertemplate: "%{x}: %{y:.3f}%<extra></extra>",
  }];
  const layout = {
    ...PLAYOUT, height: 130, margin: { l: 40, r: 10, t: 10, b: 22 },
    legend: undefined,
    yaxis: { ...PLAYOUT.yaxis, ticksuffix: "%" },
  };
  return <Plot data={traces} layout={layout} config={PCFG} style={{ width: "100%" }} useResizeHandler />;
}

// ── Section 4: basket table ──
function BasketTable({ legs }) {
  const rows = Array.isArray(legs) ? legs : [];
  const th = { padding: "3px 6px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: `2px solid #334155`, whiteSpace: "nowrap" };
  const td = { padding: "3px 6px", fontSize: 9.5, fontFamily: C.mono, color: C.text, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>CCY</th>
            <th style={{ ...th, textAlign: "right" }}>WEIGHT%</th>
            <th style={{ ...th, textAlign: "left" }}>RIC</th>
            <th style={{ ...th, textAlign: "right" }}>QUOTE</th>
            <th style={{ ...th, textAlign: "right" }}>BILATERAL</th>
            <th style={{ ...th, textAlign: "right" }}>CONTRIB bp</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l, i) => (
            <tr key={l.ric || i}>
              <td style={{ ...td, textAlign: "left", fontWeight: 700, color: C.text }}>
                {l.ccy}{l.inverted ? <span style={{ color: C.dim, fontWeight: 400 }} title="quote inverted for basket"> ⁻¹</span> : null}
              </td>
              <td style={{ ...td, textAlign: "right" }}>{pctW((l.weight ?? 0) * 100)}</td>
              <td style={{ ...td, textAlign: "left", color: C.sub }}>{l.ric || "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{qfmt(l.quote)}</td>
              <td style={{ ...td, textAlign: "right", color: C.sub }}>{qfmt(l.e)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 700, color: scol(l.contribBp) }}>{sgn(l.contribBp, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Section 8: calibration ──
function CalibrationPanel({ cal, legs, loading, onRefresh }) {
  const barclays = {};
  (legs || []).forEach((l) => { barclays[l.ccy] = (l.weight ?? 0) * 100; });
  const fw = cal?.fittedWeights || null;
  const ccys = fw ? Object.keys(fw) : [];
  const th = { padding: "2px 6px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", borderBottom: `1px solid #334155`, whiteSpace: "nowrap" };
  const td = { padding: "2px 6px", fontSize: 9, fontFamily: C.mono, whiteSpace: "nowrap" };
  const refreshBtn = (
    <button onClick={onRefresh} disabled={loading} style={{
      fontSize: 8.5, fontWeight: 700, color: loading ? C.dim : C.cyan, background: "transparent",
      border: `1px solid ${C.border}`, borderRadius: 4, padding: "2px 8px", cursor: loading ? "default" : "pointer", letterSpacing: ".05em",
    }}>{loading ? "…" : "REFRESH"}</button>
  );
  return (
    <Panel title="Calibration" right={refreshBtn} note={cal?.note}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(90px,1fr))", gap: 6, marginBottom: fw ? 8 : 0 }}>
        <Stat label="Source" value={<span style={{ fontSize: 9 }}>{cal?.source || "—"}</span>} sub={cal?.freq || null} />
        <Stat label="Tracking err" value={num(cal?.trackingErrorBp, 1)} sub="bp" tip="Tracking error of the replicated basket vs official S$NEER" color={C.amber} />
        <Stat label="Corr" value={num(cal?.corr, 4)} tip="Correlation of replicated vs official NEER" />
        <Stat label="R²" value={num(cal?.r2, 4)} tip="R² of the fit" color={C.up2} />
        {cal?.fittedTrackingErrorBp != null && (
          <Stat label="Fitted TE" value={num(cal.fittedTrackingErrorBp, 1)} sub="bp" tip="Tracking error using refit weights" color={C.up2} />
        )}
        {cal?.officialPoints != null && (
          <Stat label="Obs points" value={num(cal.officialPoints, 0)} tip="Number of official data points in the fit window" />
        )}
      </div>
      {fw ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 300 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>CCY</th>
                <th style={{ ...th, textAlign: "right" }}>BARCLAYS%</th>
                <th style={{ ...th, textAlign: "right" }}>FITTED%</th>
                <th style={{ ...th, textAlign: "right" }}>Δ</th>
              </tr>
            </thead>
            <tbody>
              {ccys.map((c) => {
                const b = barclays[c], f = fw[c];
                const d = (b != null && f != null) ? f - b : null;
                return (
                  <tr key={c}>
                    <td style={{ ...td, textAlign: "left", fontWeight: 700, color: C.text }}>{c}</td>
                    <td style={{ ...td, textAlign: "right", color: C.sub }}>{pctW(b)}</td>
                    <td style={{ ...td, textAlign: "right", color: C.text }}>{pctW(f)}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700, color: scol(d) }}>{sgn(d, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: C.dim, fontStyle: "italic" }}>No fitted weights returned.</div>
      )}
    </Panel>
  );
}

// ── Main app ──
export default function NeerApp() {
  const [activeTab, setActiveTab] = useState("monitor");
  const [snap, setSnap] = useState(null);
  const [hist, setHist] = useState(null);
  const [cal, setCal] = useState(null);
  const [calLoading, setCalLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastOk, setLastOk] = useState(null);

  // Snapshot: poll every 8s.
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const r = await fetch("/api/neer/sgd");
        if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setSnap(j); setError(null); setLastOk(Date.now()); }
      } catch (e) {
        if (alive) setError(e?.message || "backend unavailable");
      }
    }
    poll();
    const id = setInterval(poll, 8000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // History: fetch once, refresh every 60s.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch("/api/neer/sgd/history");
        if (!r.ok) throw new Error();
        const j = await r.json();
        if (alive) setHist(j);
      } catch { /* keep last good history */ }
    }
    load();
    const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Calibration: fetch once + manual refresh.
  const loadCal = useCallback(async () => {
    setCalLoading(true);
    try {
      const r = await fetch("/api/neer/sgd/calibration");
      if (!r.ok) throw new Error();
      const j = await r.json();
      setCal(j);
    } catch { /* keep last good calibration */ }
    finally { setCalLoading(false); }
  }, []);
  useEffect(() => { loadCal(); }, [loadCal]);

  const neer = snap?.neer;
  const metrics = snap?.metrics;
  const sora = snap?.sora;
  const carry = snap?.carry;
  const live = lastOk && (Date.now() - lastOk < 20000) && !error;

  const wrap = { maxWidth: 1360, margin: "0 auto", padding: "12px 16px 40px" };
  const gridStyle = { display: "grid", gap: 12 };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <div style={wrap}>

        {/* ── 1. Header bar ── */}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10, paddingBottom: 10, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: ".06em", color: C.text }}>SGD NEER</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9, fontWeight: 800, letterSpacing: ".08em", color: live ? C.up : C.dim }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: live ? C.up : C.down, boxShadow: live ? `0 0 6px ${C.up}` : "none", animation: live ? "pulse 1.6s infinite" : "none" }} />
              {live ? "LIVE" : "STALE"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 18, alignItems: "baseline", fontFamily: C.mono }}>
            <span style={{ fontSize: 9.5, color: C.sub }}>USD/SGD <b style={{ color: C.text, fontSize: 12 }}>{num(snap?.spotUSDSGD, 4)}</b></span>
            <span style={{ fontSize: 9.5, color: C.sub }}>as of <b style={{ color: C.text }}>{fmtAsof(snap?.asof)}</b></span>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div style={{ display: "flex", gap: 4, marginTop: 10, borderBottom: `1px solid ${C.border}` }}>
          {[["monitor", "MONITOR"], ["analysis", "ANALYSIS"]].map(([id, lbl]) => {
            const on = activeTab === id;
            return (
              <button key={id} onClick={() => setActiveTab(id)} style={{
                fontSize: 11, fontWeight: 800, letterSpacing: ".08em", padding: "8px 18px",
                background: "transparent", border: "none", cursor: "pointer",
                color: on ? C.cyan : C.dim,
                borderBottom: `2px solid ${on ? C.cyan : "transparent"}`, marginBottom: -1,
              }}>{lbl}</button>
            );
          })}
        </div>

        {/* ── error banner ── */}
        {error && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: "rgba(248,113,113,0.10)", border: `1px solid ${C.down}55`, color: C.down, fontSize: 10.5, fontWeight: 600 }}>
            ⚠ Backend unavailable / LSEG session not open — {error}. {lastOk ? "Showing last good snapshot." : "Waiting for first successful fetch…"}
          </div>
        )}

        {activeTab === "monitor" && (<>

        {/* ── 1b. Big readout ── */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 26, alignItems: "flex-end", padding: "14px 2px 4px" }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase" }}>S$NEER Live Index</div>
            <div style={{ fontFamily: C.mono, fontSize: 34, fontWeight: 800, color: C.text, lineHeight: 1 }}>{num(neer?.live, 3)}</div>
            <div style={{ fontFamily: C.mono, fontSize: 9, color: C.sub, marginTop: 3 }}>
              official aSGDEOP <b style={{ color: C.text }}>{num(neer?.official?.lastValue, 3)}</b> ({neer?.official?.lastDate || "—"})
            </div>
            <div style={{ fontSize: 8, color: C.dim, marginTop: 1 }}>{neer?.scaleSource || ""}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: ".08em", textTransform: "uppercase" }}>Band Position</div>
            <div style={{ fontFamily: C.mono, fontSize: 26, fontWeight: 800, color: scol(neer?.posBp), lineHeight: 1.1 }}>
              {sgn(neer?.posBp, 1)} bp <span style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}>{neer?.posBp != null ? (neer.posBp >= 0 ? "above mid" : "below mid") : ""}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase" }}>Slope</div>
              <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 700, color: C.cyan }}>{sgn(neer?.slopePctYr, 2)}%<span style={{ fontSize: 10, color: C.sub }}>/yr</span></div>
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase" }}>Width</div>
              <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 700, color: C.text }}>±{num(neer?.widthBp, 0)}<span style={{ fontSize: 10, color: C.sub }}> bp</span></div>
            </div>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase" }}>Anchor</div>
              <div style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 600, color: C.sub }}>{neer?.anchorDate || "—"} · {sgn(neer?.anchorPosBp, 0)}bp</div>
            </div>
          </div>
        </div>

        {/* ── 2. Band position gauge (prominent) ── */}
        <div style={{ marginTop: 8 }}>
          <Panel title="Band Position — Policy Band (floor → ceiling)" style={{ borderColor: "#334155" }}>
            <BandGauge neer={neer} metrics={metrics} />
          </Panel>
        </div>

        {/* ── 2b. Live intraday chart ── */}
        <div style={{ marginTop: 12 }}>
          <IntradayPanel />
        </div>

        {/* ── 3. Band history chart ── */}
        <div style={{ marginTop: 12 }}>
          <Panel title="Band History">
            <HistoryChart hist={hist} meetingActions={snap?.meetingActions} />
          </Panel>
        </div>

        {/* ── 4 + 5: basket table & SORA panel ── */}
        <div style={{ ...gridStyle, marginTop: 12, gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))" }}>
          <Panel title="Basket Composition" note="Barclays weights; CNH used for CNY. ⁻¹ = quote inverted into the basket.">
            <BasketTable legs={snap?.legs} />
          </Panel>

          <SoraPanel sora={sora} />
        </div>

        {/* ── 6 + 8: carry & calibration ── */}
        <div style={{ ...gridStyle, marginTop: 12, gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))" }}>
          <CarryPanel carry={carry} />

          <CalibrationPanel cal={cal} legs={snap?.legs} loading={calLoading} onRefresh={loadCal} />
        </div>

        {/* ── 7. Trading metrics ── */}
        <div style={{ marginTop: 12 }}>
          <Panel title="Trading Metrics">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8 }}>
              <Stat label="Pos z-score" value={num(metrics?.posZ, 2)} color={C.cyan} tip="Band-position z-score vs its own history (posBp standardised)" />
              <Stat label="Percentile" value={metrics?.posPctile != null ? `${num(metrics.posPctile, 0)}%` : "—"} tip="Historical percentile of the current band position" />
              <Stat label="Pos mean / sd" value={num(metrics?.posMeanBp, 0)} sub={`± ${num(metrics?.posSdBp, 1)} bp`} tip="Mean and standard deviation of historical band position (bp)" />
              <Stat label="To ceiling" value={num(metrics?.toCeilingBp, 0)} sub="bp" color={C.amber} tip="Distance to the band ceiling in bp" />
              <Stat label="Ceiling dist σ" value={num(metrics?.ceilingDistSigma, 2)} sub="σ" color={C.amber} tip="Distance to ceiling expressed in realized-vol sigmas" />
              <Stat label="To floor" value={num(metrics?.toFloorBp, 0)} sub="bp" color={C.up2} tip="Distance to the band floor in bp" />
              <Stat label="Realized vol" value={num(metrics?.realizedVolPctAnn, 1)} sub="%/yr" tip="Annualised realized volatility of the NEER" />
              <Stat label="MA dev 20" value={sgn(metrics?.maDev20Bp, 1)} sub={`z ${num(metrics?.maDev20Z, 2)}`} color={scol(metrics?.maDev20Bp)} tip="Deviation from 20-day moving average (bp) and its z-score" />
              <Stat label="MA dev 50" value={sgn(metrics?.maDev50Bp, 1)} sub={`z ${num(metrics?.maDev50Z, 2)}`} color={scol(metrics?.maDev50Bp)} tip="Deviation from 50-day moving average (bp) and its z-score" />
              <Stat label="Carry / vol" value={num(metrics?.carryToVol, 2)} color={scol(metrics?.carryToVol)} tip="Net carry divided by realized vol — risk-adjusted carry" />
            </div>
          </Panel>
        </div>

        <div style={{ marginTop: 16, textAlign: "center", fontSize: 8.5, color: C.dim }}>
          SGD NEER deep-dive · snapshot polled every 8s · history 60s · intraday 15s · replicated basket (Barclays weights)
        </div>

        </>)}

        {/* ── ANALYSIS tab ── */}
        {activeTab === "analysis" && <NeerAnalysis />}

      </div>

      <style>{`@keyframes pulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}`}</style>
    </div>
  );
}
