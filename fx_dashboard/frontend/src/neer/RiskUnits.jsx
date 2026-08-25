// Risk Units — vol-based position-sizing calculator.
//
// A trader already knows the product they want and sizes it to a risk budget.
// Pick currency + product + lookback window, state a USD risk target (Daily vol /
// VaR95 / VaR99), and the tool returns the notional (or DV01) to put on, plus a
// parametric-vs-historical risk profile.
//
// Vol is fetched ON DEMAND per product (ccy/product/window) from the backend:
//   GET /api/risk/vol → notional { dailyVolPct, histDown95Pct, histDown99Pct, ... }
//                    or dv01     { dailyVolBp,  histDown95Bp,  histDown99Bp,  ... }
// The amount/metric inputs only re-run the LOCAL sizing math — they never re-fetch
// vol — so typing a size doesn't hammer the LSEG feed.
import React, { useEffect, useState, useCallback } from "react";
import { F, FP } from "../calc.js";
import { InfoButton } from "./InfoDoc.jsx";

// ── Dark theme (mirrors NeerApp / the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

// ── Formatting helpers (mirror NeerApp) ──
const num = (v, dp = 3) => F(v, dp);          // null-safe fixed → "—"
const sgn = (v, dp = 1) => FP(v, dp);         // signed, "—" on null
// USD money, comma-thousands, null-safe.
const usd = (v, dp = 0) => (v == null || !isFinite(v))
  ? "—"
  : "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
// Adaptive level formatter for spot/outright quotes.
const lvl = (v) => {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(1);
  if (a >= 100) return v.toFixed(2);
  if (a >= 10) return v.toFixed(3);
  return v.toFixed(4);
};

// z-multipliers for the 95 / 99 one-sided normal tails.
const Z95 = 1.645, Z99 = 2.326;

const WINDOWS = [10, 20, 60, 90];
const METRICS = [["dailyvol", "Daily Vol"], ["var95", "VaR95"], ["var99", "VaR99"]];

// ── Small dark building blocks (local — NeerApp's aren't exported) ──
function Panel({ title, right, children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: C.sub, textTransform: "uppercase" }}>{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const selStyle = {
  background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6,
  padding: "7px 9px", fontSize: 11, fontFamily: C.mono, width: "100%", cursor: "pointer", outline: "none",
};
const inputStyle = {
  background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6,
  padding: "7px 9px", fontSize: 12, fontFamily: C.mono, width: "100%", outline: "none", boxSizing: "border-box",
};

export default function RiskUnits() {
  // Reference data
  const [ccys, setCcys] = useState([]);
  const [ccy, setCcy] = useState("");
  const [products, setProducts] = useState([]);
  const [productId, setProductId] = useState("");

  // Inputs
  const [window, setWindow] = useState(20);
  const [metric, setMetric] = useState("dailyvol");
  const [amount, setAmount] = useState("100000");   // USD risk target (string for free typing)

  // Vol (on-demand per product)
  const [vol, setVol] = useState(null);
  const [volErr, setVolErr] = useState(null);
  const [volLoading, setVolLoading] = useState(false);

  // ── 1. Currency universe (once) ──
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/currencies");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const list = [...new Set([...(j.ndfs || []), ...(j.deliverables || [])])].sort();
        setCcys(list);
        setCcy(list.includes("INR") ? "INR" : (list[0] || ""));
      } catch { /* leave empty — dropdown shows nothing until reachable */ }
    })();
    return () => { alive = false; };
  }, []);

  // ── 2. Product catalogue for the selected ccy ──
  useEffect(() => {
    if (!ccy) return;
    let alive = true;
    setProducts([]);
    setProductId("");   // clear until the new list lands (blocks a mismatched vol fetch)
    (async () => {
      try {
        const r = await fetch(`/api/risk/products?ccy=${encodeURIComponent(ccy)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        const ps = j.products || [];
        setProducts(ps);
        setProductId(ps[0]?.id || "");
      } catch { if (alive) { setProducts([]); setProductId(""); } }
    })();
    return () => { alive = false; };
  }, [ccy]);

  // ── 3. Vol for (ccy, product, window) — the ONLY thing that re-fetches ──
  //    (amount / metric changes are deliberately excluded → local re-compute only.)
  useEffect(() => {
    if (!ccy || !productId) { setVol(null); setVolErr(null); return; }
    let alive = true;
    setVolLoading(true);
    (async () => {
      try {
        const r = await fetch(`/api/risk/vol?ccy=${encodeURIComponent(ccy)}&product=${encodeURIComponent(productId)}&window=${window}`);
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) { setVol(null); setVolErr((j && (j.detail || j.error)) || `HTTP ${r.status}`); }
        else if (j && j.error) { setVol(null); setVolErr(j.error); }
        else { setVol(j); setVolErr(null); }
      } catch (e) {
        if (alive) { setVol(null); setVolErr(e?.message || "network error"); }
      } finally {
        if (alive) setVolLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [ccy, productId, window]);

  const selProduct = products.find(p => p.id === productId) || null;
  const unit = vol?.unit || selProduct?.unit || null;

  // ── Local sizing math (re-runs on every amount/metric change; no fetch) ──
  const amtNum = Number(amount);
  const validAmt = isFinite(amtNum) && amtNum > 0;
  // $ daily vol equivalent of the stated risk target.
  const equivDailyVol = !validAmt ? null
    : metric === "var95" ? amtNum / Z95
    : metric === "var99" ? amtNum / Z99
    : amtNum;

  let size = null, histVar95 = null, histVar99 = null;
  let daily = null, var95 = null, var99 = null;
  if (vol && equivDailyVol != null && unit) {
    daily = equivDailyVol;
    var95 = Z95 * equivDailyVol;
    var99 = Z99 * equivDailyVol;
    if (unit === "notional") {
      const frac = (vol.dailyVolPct ?? 0) / 100;                    // daily vol as a fraction
      if (frac > 0) {
        size = equivDailyVol / frac;                               // USD notional
        histVar95 = size * ((vol.histDown95Pct ?? 0) / 100);
        histVar99 = size * ((vol.histDown99Pct ?? 0) / 100);
      }
    } else if (unit === "dv01") {
      if (vol.dailyVolBp > 0) {
        size = equivDailyVol / vol.dailyVolBp;                     // USD DV01 per bp
        histVar95 = size * (vol.histDown95Bp ?? 0);
        histVar99 = size * (vol.histDown99Bp ?? 0);
      }
    }
  }

  const headline = size == null ? "—"
    : unit === "notional"
      ? `${(size / 1e6).toFixed(2)} mm USD`
      : `${Math.round(size).toLocaleString("en-US")} USD/bp`;

  const underline = (() => {
    if (!vol) return null;
    if (unit === "notional") {
      return `spot/outright ${lvl(vol.level)} · daily vol ${num(vol.dailyVolPct, 3)}% (${vol.window}d, ${vol.nObs} obs)`;
    }
    return `fwd-fwd rate ${num(vol.level, 3)}% · daily vol ${num(vol.dailyVolBp, 2)} bp (${vol.window}d, ${vol.nObs} obs)`;
  })();

  // ── Styles ──
  const wrap = { maxWidth: 1120, margin: "0 auto", padding: "16px 16px 48px" };
  const th = { padding: "5px 8px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", letterSpacing: ".05em", borderBottom: `2px solid #334155`, whiteSpace: "nowrap", textAlign: "right" };
  const thL = { ...th, textAlign: "left" };
  const td = { padding: "6px 8px", fontSize: 11, fontFamily: C.mono, color: C.text, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}`, textAlign: "right" };
  const tdL = { ...td, textAlign: "left", color: C.sub, fontFamily: "inherit", fontWeight: 700, fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em" };

  const riskRows = [
    { k: "Daily vol", param: daily, hist: null, red: false, histNA: true },
    { k: "VaR95", param: var95, hist: histVar95, red: true },
    { k: "VaR99", param: var99, hist: histVar99, red: true },
  ];

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <div style={wrap}>

        {/* ── Header ── */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: ".05em", color: C.text }}>RISK UNITS</span>
          <span style={{ fontSize: 10, color: C.sub }}>vol-based position sizing — size a known product to a USD risk budget</span>
          <span style={{ marginLeft: "auto", alignSelf: "center" }}><InfoButton docKey="risk" /></span>
        </div>

        {/* ── Body: inputs + results ── */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 14, marginTop: 14, alignItems: "start" }}>

          {/* ── Inputs ── */}
          <Panel title="Inputs">
            <Field label="Currency">
              <select style={selStyle} value={ccy} onChange={e => setCcy(e.target.value)}>
                {ccys.length === 0 && <option value="">—</option>}
                {ccys.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>

            <Field label="Product">
              <select style={selStyle} value={productId} onChange={e => setProductId(e.target.value)} disabled={!products.length}>
                {!products.length && <option value="">{ccy ? "loading…" : "—"}</option>}
                {products.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              {selProduct && (
                <div style={{ fontSize: 8.5, color: C.dim, marginTop: 4, fontFamily: C.mono }}>
                  unit: <b style={{ color: selProduct.unit === "dv01" ? C.amber : C.cyan }}>{selProduct.unit}</b>
                </div>
              )}
            </Field>

            <Field label="Lookback window">
              <div style={{ display: "flex", gap: 6 }}>
                {WINDOWS.map(w => {
                  const on = window === w;
                  return (
                    <button key={w} onClick={() => setWindow(w)} style={{
                      flex: 1, fontSize: 10, fontWeight: 800, fontFamily: C.mono, padding: "6px 0", borderRadius: 5, cursor: "pointer",
                      background: on ? "rgba(34,211,238,0.14)" : C.panel2,
                      border: `1px solid ${on ? C.cyan : C.border}`,
                      color: on ? C.cyan : C.sub,
                    }}>{w}d</button>
                  );
                })}
              </div>
            </Field>

            <Field label="Risk target (USD)">
              <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <select style={{ ...selStyle, width: 118, flex: "0 0 auto" }} value={metric} onChange={e => setMetric(e.target.value)}>
                  {METRICS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
                </select>
                <input
                  style={inputStyle}
                  type="number" min="0" step="1000"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0"
                />
                <span style={{ display: "flex", alignItems: "center", fontSize: 10, fontWeight: 700, color: C.dim, letterSpacing: ".05em" }}>USD</span>
              </div>
              <div style={{ fontSize: 8.5, color: C.dim, marginTop: 4 }}>
                target is in USD (the P&L currency)
              </div>
            </Field>
          </Panel>

          {/* ── Results ── */}
          <Panel
            title="Size to put on"
            right={volLoading
              ? <span style={{ fontSize: 9, color: C.dim, fontWeight: 700 }}>fetching vol…</span>
              : vol ? <span style={{ fontSize: 9, color: C.up2, fontWeight: 700, letterSpacing: ".06em" }}>{unit === "dv01" ? "DV01" : "NOTIONAL"}</span> : null}
          >
            {/* amber note on vol failure */}
            {volErr && (
              <div style={{ marginBottom: 12, padding: "8px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600, lineHeight: 1.45 }}>
                vol unavailable — {volErr} (the LSEG history endpoint may be rate-limited; retry shortly)
              </div>
            )}

            {/* headline */}
            <div style={{ fontFamily: C.mono, fontSize: 40, fontWeight: 800, color: size == null ? C.dim : C.text, lineHeight: 1.05, letterSpacing: "-.01em" }}>
              {headline}
            </div>
            <div style={{ fontSize: 10, color: C.sub, marginTop: 6, minHeight: 14, fontFamily: C.mono }}>
              {underline || (volLoading ? "fetching vol…" : "—")}
            </div>

            {/* risk profile table */}
            <div style={{ marginTop: 16, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
                <thead>
                  <tr>
                    <th style={thL}>Metric</th>
                    <th style={th}>Parametric&nbsp;$</th>
                    <th style={th}>Historical&nbsp;$</th>
                  </tr>
                </thead>
                <tbody>
                  {riskRows.map(r => (
                    <tr key={r.k}>
                      <td style={tdL}>{r.k}</td>
                      <td style={{ ...td, color: r.red ? C.down : C.text }}>{usd(r.param)}</td>
                      <td style={{ ...td, color: r.histNA ? C.dim : C.down }}>{r.histNA ? "—" : usd(r.hist)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* caveat */}
            <div style={{ fontSize: 8.5, color: C.dim, marginTop: 12, fontStyle: "italic", lineHeight: 1.5 }}>
              Parametric VaR assumes normal (z·σ); historical uses the actual {window}d return distribution. Sizing is on-demand per product.
            </div>
          </Panel>

        </div>
      </div>
    </div>
  );
}
