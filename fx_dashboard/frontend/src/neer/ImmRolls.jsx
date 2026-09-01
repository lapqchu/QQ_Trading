// IMM ROLLS — quarterly roll seasonality study (deep-dive tab 7).
//
// Reconstructs the history of IMM-dated forward-forward implied yields from
// daily anchor points + the SOFR OIS curve (same DF engine as the pricer) and
// shows, per currency × roll pair: every year's path of the fwd-fwd yield in
// event time (business days to the near IMM date), re-anchored at the ~1M-before
// entry, plus the per-year Δ to the last tradable day. n is SMALL by
// construction (USD OIS history starts Jun-2018 → ≤8 completed cycles), so the
// display is year-dots and bootstrap CIs — never smooth curves faking confidence.
//
//   GET /api/immroll/universe · GET /api/immroll/study?ccy=&pair=
import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { InfoButton } from "./InfoDoc.jsx";

const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};
const fm = (v, dp = 1) => (v == null || !isFinite(v)) ? "—" : v.toFixed(dp);
const fsgn = (v, dp = 1) => (v == null || !isFinite(v)) ? "—" : (v > 0 ? "+" : "") + v.toFixed(dp);

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

const PAIR_LABELS = { MAR_JUN: "Mar→Jun", JUN_SEP: "Jun→Sep", SEP_DEC: "Sep→Dec", DEC_MAR: "Dec→Mar" };

export default function ImmRolls() {
  const [uni, setUni] = useState(null);
  const [uniErr, setUniErr] = useState(null);
  const [ccy, setCcy] = useState("TWD");
  const [pair, setPair] = useState("SEP_DEC");
  const [study, setStudy] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/immroll/universe")
      .then(async (r) => { const j = await r.json().catch(() => null);
        if (!r.ok) { setUniErr((j && j.detail) || `HTTP ${r.status}`); return; }
        setUni(j); })
      .catch((e) => setUniErr(e?.message || "network error"));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    fetch(`/api/immroll/study?ccy=${ccy}&pair=${pair}`)
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) { setStudy(null); setErr((j && j.detail) || `HTTP ${r.status}`); }
        else { setStudy(j); setErr(null); }
      })
      .catch((e) => alive && (setStudy(null), setErr(e?.message || "network error")))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [ccy, pair]);

  const okCcys = (uni?.universe || []).filter((r) => r.ok);
  const badCcys = (uni?.universe || []).filter((r) => !r.ok);
  const s = study?.stats;
  const wrap = { maxWidth: 1320, margin: "0 auto", padding: "16px 16px 48px" };
  const turnFlag = (study?.flags || []).find((f) => f.code === "TURN_CONTAMINATED");

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <div style={wrap}>

        {/* header */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: ".05em" }}>IMM ROLLS</span>
          <span style={{ fontSize: 10, color: C.sub }}>quarterly roll seasonality — fwd-fwd yield in event time, DF-reconstructed from daily curves</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            {(study?.upcomingImm || []).map((u) => (
              <span key={u.date} style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 800, color: u.bd <= 21 ? C.amber : C.dim,
                                          border: `1px solid ${u.bd <= 21 ? C.amber : C.border}55`, borderRadius: 5, padding: "2px 8px" }}
                    title={u.date}>
                {u.label} IMM: {u.bd}bd
              </span>
            ))}
          </span>
          <span style={{ alignSelf: "center" }}><InfoButton docKey="immroll" /></span>
        </div>

        {uniErr && <div style={{ marginTop: 12, color: C.amber, fontSize: 10 }}>universe unavailable — {uniErr}</div>}

        {/* selectors */}
        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {okCcys.map((r) => (
              <button key={r.code} onClick={() => setCcy(r.code)} style={{
                fontSize: 9.5, fontWeight: 800, fontFamily: C.mono, padding: "4px 9px", borderRadius: 5, cursor: "pointer",
                background: ccy === r.code ? "rgba(34,211,238,0.14)" : C.panel2,
                border: `1px solid ${ccy === r.code ? C.cyan : C.border}`, color: ccy === r.code ? C.cyan : C.sub,
              }}>{r.code}{r.ndf && <span style={{ fontSize: 7, color: C.dim }}> N</span>}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {Object.entries(PAIR_LABELS).map(([id, lbl]) => (
              <button key={id} onClick={() => setPair(id)} style={{
                fontSize: 9.5, fontWeight: 800, fontFamily: C.mono, padding: "4px 10px", borderRadius: 5, cursor: "pointer",
                background: pair === id ? "rgba(167,139,250,0.14)" : C.panel2,
                border: `1px solid ${pair === id ? C.violet : C.border}`, color: pair === id ? C.violet : C.sub,
              }}>{lbl}</button>
            ))}
          </div>
          {badCcys.length > 0 && (
            <span style={{ fontSize: 8.5, color: C.dim }} title={badCcys.map((r) => `${r.code}: ${r.reason}`).join("\n")}>
              {badCcys.length} ccys excluded (hover for the audit reasons)
            </span>
          )}
        </div>

        {turnFlag && (
          <div style={{ marginTop: 10, padding: "8px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
            ⚠ {turnFlag.detail}
          </div>
        )}
        {err && (
          <div style={{ marginTop: 10, padding: "8px 11px", borderRadius: 6, background: "rgba(248,113,113,0.10)", border: `1px solid ${C.down}55`, color: C.down, fontSize: 10, fontWeight: 600 }}>
            {err}
          </div>
        )}

        {/* stats strip */}
        {study && s && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 12 }}>
            {[
              ["MEAN Δ (entry→exit)", s.meanBp != null ? `${fsgn(s.meanBp)}bp` : "—", s.meanBp == null ? C.dim : s.meanBp > 0 ? C.up2 : C.down],
              ["MEDIAN Δ", s.medianBp != null ? `${fsgn(s.medianBp)}bp` : "—", C.text],
              ["HIT RATE (Δ>0)", s.hitRate != null ? `${(100 * s.hitRate).toFixed(0)}%` : "—", C.text],
              ["95% CI (bootstrap)", s.ci95 ? `[${fsgn(s.ci95[0])}, ${fsgn(s.ci95[1])}]` : "—", s.ci95 && s.ci95[0] > 0 ? C.up2 : s.ci95 && s.ci95[1] < 0 ? C.down : C.dim],
              ["YEARS", String(s.n), s.n < 6 ? C.amber : C.text],
              ["THIS YEAR vs SEASONAL", study.currentZ != null ? `z ${fsgn(study.currentZ, 2)}` : "—", study.currentZ != null && Math.abs(study.currentZ) >= 1.5 ? C.amber : C.text],
            ].map(([lbl, val, col]) => (
              <div key={lbl} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 7.5, fontWeight: 700, color: C.dim, letterSpacing: ".06em" }}>{lbl}</div>
                <div style={{ fontFamily: C.mono, fontSize: 15, fontWeight: 800, color: col }}>{val}</div>
              </div>
            ))}
          </div>
        )}

        {/* event-time chart */}
        <Panel title={`${ccy} ${PAIR_LABELS[pair]} fwd-fwd — Δ from entry (bd ${study?.entryBd ?? -21}) in bp · x = business days to near IMM`} style={{ marginTop: 12 }}
               right={loading ? <span style={{ fontSize: 9, color: C.dim }}>reconstructing…</span> : null}>
          {study ? (
            <Plot
              data={[
                ...study.events.filter((e) => !e.current).map((e) => ({
                  x: e.delta.map((p) => p[0]), y: e.delta.map((p) => p[1]),
                  name: String(e.year), mode: "lines",
                  line: { color: "rgba(148,163,184,0.28)", width: 1 },
                  hovertemplate: `${e.year}: bd %{x} · %{y:.1f}bp<extra></extra>`,
                })),
                {
                  x: (study.meanPath || []).map((p) => p[0]), y: (study.meanPath || []).map((p) => p[1]),
                  name: "mean (yrs ≥4)", mode: "lines", line: { color: C.cyan, width: 2.4 },
                  customdata: (study.meanPath || []).map((p) => p[2]),
                  hovertemplate: "mean bd %{x}: %{y:.1f}bp (n=%{customdata})<extra></extra>",
                },
                ...study.events.filter((e) => e.current).map((e) => ({
                  x: e.delta.map((p) => p[0]), y: e.delta.map((p) => p[1]),
                  name: `${e.year} (current)`, mode: "lines",
                  line: { color: C.amber, width: 2.2 },
                  hovertemplate: `${e.year} bd %{x}: %{y:.1f}bp<extra></extra>`,
                })),
              ]}
              layout={{
                paper_bgcolor: C.panel, plot_bgcolor: C.panel2, height: 320,
                font: { color: C.sub, size: 9, family: "Inter,system-ui" },
                margin: { l: 46, r: 14, t: 8, b: 30 }, hovermode: "closest",
                xaxis: { gridcolor: C.border, tickfont: { size: 8 }, title: { text: "business days to near IMM date", font: { size: 8.5 } }, automargin: true },
                yaxis: { gridcolor: C.border, zerolinecolor: "#475569", zeroline: true, tickfont: { size: 8 }, ticksuffix: "bp", automargin: true },
                showlegend: false,
              }}
              config={{ responsive: true, displayModeBar: false, displaylogo: false }}
              style={{ width: "100%" }} useResizeHandler
            />
          ) : !err ? <div style={{ fontSize: 10, color: C.dim, fontStyle: "italic", padding: 20 }}>loading study…</div> : null}
          {study && (
            <div style={{ fontSize: 8.5, color: C.dim, marginTop: 6, lineHeight: 1.6 }}>
              grey = completed years · cyan = cross-year mean (only where ≥4 years observed) · amber = current cycle ·
              exit is the LAST day the near leg trades as a forward (~5bd before IMM for T+2) ·
              displayed on the ccy's MM basis (Act/{study.iyBasis})
              {(study.flags || []).filter((f) => f.code === "SKIPPED_DAYS").map((f) => ` · ${f.count} days dropped (incomplete curve — never interpolated over)`)}
            </div>
          )}
        </Panel>

        {/* per-year Δ dots */}
        {study && s?.deltas?.length > 0 && (
          <Panel title="Δ per year — entry→exit, one dot per completed cycle (the honest view at n≤8)" style={{ marginTop: 12 }}>
            <Plot
              data={[{
                x: s.deltas.map((d) => d.year), y: s.deltas.map((d) => d.bp),
                mode: "markers", type: "scatter",
                marker: { size: 10, color: s.deltas.map((d) => d.bp >= 0 ? C.up2 : C.down) },
                hovertemplate: "%{x}: %{y:.1f}bp<extra></extra>",
              }]}
              layout={{
                paper_bgcolor: C.panel, plot_bgcolor: C.panel2, height: 160,
                font: { color: C.sub, size: 9, family: "Inter,system-ui" },
                margin: { l: 46, r: 14, t: 6, b: 24 },
                xaxis: { gridcolor: C.border, tickfont: { size: 8 }, dtick: 1, automargin: true },
                yaxis: { gridcolor: C.border, zerolinecolor: "#475569", zeroline: true, tickfont: { size: 8 }, ticksuffix: "bp", automargin: true },
                shapes: s.meanBp != null ? [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: s.meanBp, y1: s.meanBp, line: { color: C.cyan, width: 1, dash: "dot" } }] : [],
              }}
              config={{ responsive: true, displayModeBar: false, displaylogo: false }}
              style={{ width: "100%" }} useResizeHandler
            />
          </Panel>
        )}

        <div style={{ fontSize: 8.5, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
          Reconstruction: daily anchor outrights (spot + composite points) → USD DF curve from that day's SOFR OIS
          (annual-coupon bootstrap beyond 1Y) → ccy DF nodes → log-linear interval DF between the two IMM dates —
          the pricer's own DF engine, applied historically. {uni?.windowNote}.
          Value dates use weekday arithmetic (no holiday calendars) — second-order for a Δ-study, not pricing-grade.
          Positive Δ = the far leg richened vs the near from entry to exit (long-roll P&L in yield terms, before costs).
        </div>
      </div>
    </div>
  );
}
