// SG Fundamentals — Singapore country-fundamentals monitor (deep-dive tab 4).
//
// Replicates the indicator set MAS itself tracks (Macroeconomic Review / MPS /
// BIS 142): inflation + y/y contributions by CPI component, consensus vs prior
// for upcoming prints, imported- and domestic-cost drivers, activity, labour,
// monetary, the MPS decision history and the release calendar.
//
// Data: ONE fetch of /api/fund/sg on mount (backend caches 6h) + a manual
// refresh button. This tab never polls — everything here is monthly/quarterly
// official statistics.
import React, { useEffect, useState, useCallback } from "react";
import Plot from "react-plotly.js";
import { F, FP } from "../calc.js";
import { InfoButton } from "./InfoDoc.jsx";

// ── Dark theme (mirrors NeerApp / the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

const PLAYOUT = {
  paper_bgcolor: C.panel, plot_bgcolor: C.panel2,
  font: { color: C.sub, size: 9, family: "Inter,system-ui" },
  margin: { l: 46, r: 16, t: 26, b: 26 },
  xaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true },
  yaxis: { gridcolor: C.border, zerolinecolor: "#475569", tickfont: { size: 8 }, automargin: true },
  hovermode: "x unified",
  legend: { font: { size: 8 }, bgcolor: "transparent", orientation: "h", x: 0, y: 1.16 },
};
function chartLayout(uirev, over = {}) {
  const { xaxis = {}, yaxis = {}, ...rest } = over;
  return { ...PLAYOUT, uirevision: uirev, ...rest,
    xaxis: { ...PLAYOUT.xaxis, ...xaxis }, yaxis: { ...PLAYOUT.yaxis, ...yaxis } };
}
const PCFG = { responsive: true, displayModeBar: false, displaylogo: false };

function Panel({ title, note, right, children, style }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, ...style }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".12em", color: C.sub }}>{title}</span>
          {note && <span style={{ fontSize: 9, color: C.dim, marginLeft: 8 }}>{note}</span>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

const line = (s, name, color, extra = {}) => ({
  x: s?.dates || [], y: s?.values || [], name, type: "scatter", mode: "lines",
  line: { color, width: 1.6 }, ...extra,
});
const lastVal = (s) => (s?.values?.length ? s.values[s.values.length - 1] : null);
const lastDate = (s) => (s?.dates?.length ? s.dates[s.dates.length - 1] : null);

// COE exercise key "YYYY-MM-<bid#>" → display label. The data.gov.sg dataset
// carries month + exercise number only (NO auction dates) — these must be
// plotted on a CATEGORY axis; a date axis would parse "2026-08-2" as Aug 2nd.
const exLabel = (e) => `${String(e).slice(0, 7)} #${String(e).slice(8)}`;
const COE_XAXIS = { type: "category", categoryorder: "category ascending", nticks: 8 };

function Lines({ id, series, height = 190, ytitle = "%", yzero = true, shapes = [], yover = {}, xover = {} }) {
  return (
    <Plot
      data={series}
      layout={chartLayout(id, {
        height, shapes,
        xaxis: xover,
        yaxis: { title: { text: ytitle, font: { size: 8 } }, zeroline: yzero, ...yover },
      })}
      config={PCFG} style={{ width: "100%" }} useResizeHandler
    />
  );
}

// Provenance chip for nowcast panels: does this series feed M1, or is it
// situational awareness only? (The question every panel must answer.)
function Chip({ on, children }) {
  return (
    <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: ".07em", padding: "2px 6px",
                   borderRadius: 4, whiteSpace: "nowrap",
                   border: `1px solid ${on ? C.cyan + "88" : C.border}`,
                   color: on ? C.cyan : C.dim }}>
      {children}
    </span>
  );
}

// A blocked/unavailable data slot: flagged loudly, never proxied. Corporate
// networks often block SingStat/data.gov.sg for Python while the browser gets
// through — EXT_DATA_PROXY routes the backend's external fetches via the proxy.
function Missing({ what, err, height = 150 }) {
  return (
    <div style={{ minHeight: height, display: "flex", flexDirection: "column", justifyContent: "center",
                  textAlign: "center", color: C.dim, fontSize: 10.5, lineHeight: 1.6, padding: "8px 14px" }}>
      <div><span style={{ color: C.amber, fontWeight: 700 }}>{what} unavailable</span>{err ? ` — ${String(err).slice(0, 90)}` : ""}</div>
      <div style={{ fontSize: 9.5, marginTop: 4 }}>
        nothing proxied · if this network blocks the source, set EXT_DATA_PROXY to the corporate proxy and restart the backend
      </div>
    </div>
  );
}

// ── header stat chip ──
function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", minWidth: 108 }}>
      <div style={{ fontSize: 9, letterSpacing: ".1em", color: C.dim, fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 17, fontWeight: 600, color: color || C.text, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: C.sub, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function MonitorView({ data, err, busy, load }) {
  if (err) return <div style={{ padding: 30, color: C.down, fontFamily: C.mono, fontSize: 12 }}>SG Fundamentals failed: {err}</div>;
  if (!data) return <div style={{ padding: 30, color: C.dim, fontSize: 12 }}>Loading Singapore fundamentals… (first build pulls ~8 years of official series, ~10s)</div>;

  const inf = data.inflation, con = data.consensus, drv = data.drivers,
        act = data.activity, lab = data.labour, mon = data.monetary, pol = data.policy;
  const range = inf.masRange2026;
  const contrib = inf.contributions || { rows: [] };
  const cpiRow = (con.rows || []).find((r) => r.key === "cpiYoY") || {};
  const coreRow = (con.rows || []).find((r) => r.key === "coreYoY") || {};

  // MAS 2026 forecast band across calendar-2026 on the inflation chart
  const bandShape = {
    type: "rect", xref: "x", yref: "y", x0: "2026-01-01", x1: "2026-12-31",
    y0: range.low, y1: range.high, fillcolor: "rgba(34,211,238,0.08)",
    line: { color: "rgba(34,211,238,0.35)", width: 1, dash: "dot" },
  };

  // contributions bar (latest month), sorted, core vs excluded colouring
  const crows = [...(contrib.rows || [])].filter((r) => r.contribution != null)
    .sort((a, b) => a.contribution - b.contribution);
  const contribTrace = {
    type: "bar", orientation: "h",
    y: crows.map((r) => r.label), x: crows.map((r) => r.contribution),
    marker: { color: crows.map((r) => (r.core ? C.cyan : C.amber)) },
    text: crows.map((r) => `${FP(r.yoy, 1)}% y/y · w ${(r.w / 100).toFixed(1)}%`),
    textposition: "none", hovertemplate: "%{y}: %{x:.2f}pp — %{text}<extra></extra>",
  };

  // COE per-exercise history (Cat A/B/E) — category axis: see exLabel
  const coeH = drv.coe?.history || {};
  const coeTraces = [["Category A", C.cyan], ["Category B", C.blue], ["Category E", C.violet]]
    .filter(([k]) => coeH[k])
    .map(([k, col]) => ({
      x: coeH[k].exercises.map(exLabel), y: coeH[k].premiums, name: k.replace("Category", "Cat"),
      type: "scatter", mode: "lines+markers", line: { color: col, width: 1.4 },
      marker: { size: 3 },
    }));
  const coeLatest = drv.coe?.latest || {};

  const staleSrc = Object.entries(data.sources || {}).filter(([, v]) => v?.stale).map(([k]) => k);
  const srcErr = (key) => (data.sources || {})[key]?.error || null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (data.calendar || []).filter((c) => c.date >= today);   // backend caps at ~6 months

  return (
    <div style={{ padding: 14, maxWidth: 1500, margin: "0 auto" }}>
      {/* ── header strip ── */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch", marginBottom: 12 }}>
        <Stat label="HEADLINE CPI Y/Y" value={`${F(inf.latest.headline, 2)}%`} sub={`as of ${inf.latest.month || "—"}`} color={C.cyan} />
        <Stat label="MAS CORE Y/Y" value={`${F(inf.latest.core, 1)}%`} sub="ex accommodation & private transport" color={C.cyan} />
        {(() => {   // roll forward: the vendor keeps VALUE_DT1 on the LAST release for days
          const relDate = String(cpiRow.releaseDate || "").slice(0, 10);
          if (relDate && relDate >= today) {
            return <Stat label="NEXT PRINT" value={relDate} sub={`cons ${F(cpiRow.mean, 2)}% hl / ${F(coreRow.mean, 1)}% core`} color={C.amber} />;
          }
          const nextCpi = upcoming.find((c) => /CPI/i.test(c.event));
          return <Stat label="NEXT PRINT" value={nextCpi ? `${nextCpi.date}${nextCpi.est ? " ~" : ""}` : "—"}
            sub={relDate ? `last (${relDate.slice(5)}): ${F(cpiRow.actual, 2)}% hl / ${F(coreRow.actual, 1)}% core · new poll pending` : "—"}
            color={C.amber} />;
        })()}
        <Stat label="MAS 2026 RANGE" value={`${range.low}–${range.high}%`} sub={`core & headline · as of ${range.asOf}`} />
        <Stat label="OUTPUT GAP 2026" value={FP(act.outputGap2026, 1) + "%"} sub="of potential · MR Jul-26" />
        <Stat label="MTI GDP 2026" value={`${act.mtiGdpRange2026.low}–${act.mtiGdpRange2026.high}%`} sub={`upgraded ${act.mtiGdpRange2026.asOf}`} />
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, alignItems: "flex-end" }}>
          <button onClick={() => load(true)} disabled={busy}
            style={{ background: C.panel2, color: C.cyan, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 14px", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", cursor: "pointer" }}>
            {busy ? "REFRESHING…" : "REFRESH"}
          </button>
          <div style={{ fontSize: 8.5, color: staleSrc.length ? C.amber : C.dim, fontFamily: C.mono }}>
            built {String(data.asOf).slice(5, 16)} · {data.buildSecs}s{staleSrc.length ? ` · stale: ${staleSrc.join(",")}` : ""}
          </div>
        </div>
      </div>

      {/* ── row 1: inflation ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1.25fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="INFLATION" note="y/y % · shaded = MAS 2026 forecast range">
          <Lines id="sgf-infl" height={230} shapes={[bandShape]} series={[
            line(inf.headlineYoY, "Headline", C.cyan),
            line(inf.coreYoY, "MAS Core", C.amber),
          ]} />
        </Panel>
        <Panel title="CONTRIBUTIONS TO HEADLINE Y/Y" note={`${contrib.asOf || ""} · cyan=in core, amber=excluded`}>
          {crows.length ? (<>
            <Plot data={[contribTrace]}
              layout={chartLayout("sgf-contrib", {
                height: 230, margin: { l: 128, r: 12, t: 8, b: 24 },
                xaxis: { title: { text: "pp", font: { size: 8 } }, zeroline: true },
                yaxis: { tickfont: { size: 8 } },
              })}
              config={PCFG} style={{ width: "100%" }} useResizeHandler />
            <div style={{ fontSize: 9, color: C.sub, fontFamily: C.mono, marginTop: 2 }}>
              Σ core {FP(contrib.coreContrib, 2)}pp · Σ excluded {FP(contrib.nonCoreContrib, 2)}pp → headline {F(contrib.headlineYoY, 2)}%
            </div>
          </>) : <Missing what="CPI component detail (SingStat M213751)" err={srcErr("cpiGroups")} height={230} />}
        </Panel>
        <Panel title="CORE GROUPS" note="official MAS groupings, y/y %">
          {inf.coreGroupsYoY?.coreYoYOfficial?.dates?.length ? (
            <Lines id="sgf-coregrp" height={230} series={[
              line(inf.coreGroupsYoY?.coreYoYOfficial, "MAS Core (official)", C.cyan),
              line(inf.coreGroupsYoY?.["Services"], "Services", C.blue),
              line(inf.coreGroupsYoY?.["Retail & other goods"], "Retail & other goods", C.violet),
              line(inf.coreGroupsYoY?.["Electricity & gas"], "Electricity & gas", C.amber),
            ]} />
          ) : <Missing what="MAS core groupings (SingStat M213891)" err={srcErr("coreGroups")} height={230} />}
        </Panel>
      </div>

      {/* ── row 2: drivers ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="IMPORTED COSTS" note="y/y % (import & export price indices)">
          <Lines id="sgf-imp" height={180} series={[
            line(drv.importPricesYoY, "Import prices", C.cyan),
            line(drv.exportPricesYoY, "Export prices", C.blue),
          ]} />
        </Panel>
        <Panel title="S$NEER Y/Y" note="official weekly series, monthly avg — appreciation dampens imported inflation">
          <Lines id="sgf-neer" height={180} series={[line(drv.neerYoY, "S$NEER y/y", C.cyan)]} />
        </Panel>
        <Panel title="COE PREMIUMS" note="per bidding exercise #1/#2 (~2wks apart; dataset carries month + exercise no., not auction dates)"
          right={<span style={{ fontFamily: C.mono, fontSize: 9, color: C.sub }}>
            A {coeLatest["Category A"] ? Math.round(coeLatest["Category A"].premium / 1000) + "k" : "—"} ·
            B {coeLatest["Category B"] ? Math.round(coeLatest["Category B"].premium / 1000) + "k" : "—"}
          </span>}>
          {coeTraces.length ? (
            <Lines id="sgf-coe" height={180} ytitle="S$" yzero={false} series={coeTraces} xover={COE_XAXIS} />
          ) : (drv.coeMonthly?.small?.dates?.length ? (<>
            <Lines id="sgf-coepqp" height={158} ytitle="S$" yzero={false} series={[
              line(drv.coeMonthly.small, "PQP ≤1600cc (Cat A-type)", C.cyan),
              line(drv.coeMonthly.large, "PQP >1600cc (Cat B-type)", C.blue),
            ]} />
            <div style={{ fontSize: 9, color: C.amber, marginTop: 2, lineHeight: 1.4 }}>
              bidding results (data.gov.sg) unreachable — showing LSEG COE PQP instead: the official Prevailing Quota Premium, a SMOOTHED MONTHLY AVERAGE, not per-exercise premiums
            </div>
          </>) : <Missing what="COE bidding results (data.gov.sg)" err={drv.coe?.error} height={180} />)}
        </Panel>
        <Panel title="RENTS & TARIFF" note="URA private rental index y/y (accommodation feeds CPI with ~4–8q lag)">
          {drv.uraRent?.yoy?.dates?.length
            ? <Lines id="sgf-rent" height={150} series={[line(drv.uraRent?.yoy, "URA rental y/y", C.cyan)]} />
            : <Missing what="URA rental index (SingStat M212311)" err={srcErr("uraRent")} height={150} />}
          <div style={{ fontSize: 9.5, color: C.amber, marginTop: 4, lineHeight: 1.4 }}>⚡ {drv.tariff?.note}</div>
        </Panel>
      </div>

      {/* ── row 3: activity ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="GDP & PMI" note="real GDP y/y (quarterly) · SIPMM PMI (50 = neutral, rhs)">
          <Plot
            data={[
              { ...line(act.gdpYoY, "GDP y/y", C.cyan), type: "bar", marker: { color: C.cyan }, line: undefined },
              { ...line(act.pmi, "PMI (rhs)", C.amber), yaxis: "y2" },
            ]}
            layout={chartLayout("sgf-gdp", {
              height: 190, margin: { l: 46, r: 40, t: 26, b: 26 },
              yaxis: { title: { text: "%", font: { size: 8 } }, zeroline: true },
              yaxis2: { overlaying: "y", side: "right", gridcolor: "transparent",
                        zeroline: false, tickfont: { size: 8, color: C.amber }, automargin: true },
              shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 50, y1: 50, yref: "y2",
                         line: { color: C.dim, width: 1, dash: "dot" } }],
            })}
            config={PCFG} style={{ width: "100%" }} useResizeHandler
          />
        </Panel>
        <Panel title="TRADE & PRODUCTION" note="y/y %">
          <Lines id="sgf-trade" height={190} series={[
            line(act.nodxYoY, "NODX", C.cyan),
            line(act.ipYoY, "Industrial production", C.blue),
          ]} />
        </Panel>
        <Panel title="DOMESTIC DEMAND & LABOUR" note="retail volume y/y · unemployment (SA) · ULC y/y">
          <Lines id="sgf-dom" height={190} series={[
            line(act.retailYoY, "Retail volume y/y", C.cyan),
            line(lab.unemp, "Unemployment (SA)", C.amber),
            line(lab.ulcYoY, "ULC y/y (q)", C.violet),
          ]} />
        </Panel>
      </div>

      {/* ── row 4: monetary + policy + calendar ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="MONEY & CREDIT" note="y/y %">
          <Lines id="sgf-money" height={200} series={[
            line(mon.m2YoY, "M2", C.cyan),
            line(mon.loansBizYoY, "Loans: businesses", C.blue),
            line(mon.loansConsYoY, "Loans: consumers", C.violet),
            line(mon.loansHousYoY, "Housing loans", C.amber),
          ]} />
        </Panel>
        <Panel title="MPS DECISIONS" note={`next: ${pol.nextMeeting}`}>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
              <tbody>
                {[...pol.decisions].reverse().map((d) => (
                  <tr key={d.date} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ fontFamily: C.mono, color: C.dim, padding: "3px 6px", whiteSpace: "nowrap" }}>{d.date}</td>
                    <td style={{ color: d.action.includes("↑") ? C.up : d.action.includes("↓") || d.action.includes("0%") ? C.down : C.sub, padding: "3px 6px" }}>{d.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 9, color: C.sub, marginTop: 6, fontFamily: C.mono }}>
            SPF Jun-26 medians: CPI {pol.spf.cpi2026}% · core {pol.spf.core2026}% · GDP {pol.spf.gdp2026}% · USD/SGD {pol.spf.usdsgdEnd2026} · SORA {pol.spf.soraAvg2026}%
          </div>
        </Panel>
        <Panel title="RELEASE CALENDAR" note="next ~6 months · confirmed (polls + verified one-offs) + ~ = estimated from habitual release day">
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
              <tbody>
                {upcoming.map((c) => (
                  <tr key={c.date + c.event} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ fontFamily: C.mono, color: c.date <= today ? C.amber : c.est ? C.dim : C.sub, padding: "4px 6px", whiteSpace: "nowrap" }}>{c.date}</td>
                    <td style={{ color: c.est ? C.dim : C.sub, padding: "4px 6px" }}>{c.event}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>
            Consensus rows (Reuters polls): {(con.rows || []).map((r) => `${r.label} ${r.mean != null ? F(r.mean, 1) : "—"}`).join(" · ")}
          </div>
        </Panel>
      </div>

      <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, paddingBottom: 20 }}>
        Sources: LSEG econ indicators (aSG…) + Reuters polls · SingStat M213751/M213891/M015631/M212311 · data.gov.sg COE ·
        weights = DOS 2024 rebasing paper · MAS Core = headline − accommodation − private transport (64.4% of basket) ·
        cached 6h, no polling · {lab.note}
      </div>
    </div>
  );
}

// ═══════════════════════ MODEL sub-tab ═══════════════════════
// Bottom-up component nowcast (M1) + Phillips curve (M2) + backtest.
function ModelView({ consensus }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/fund/sg/model${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setData(await r.json());
    } catch (e) { setErr(String(e).slice(0, 300)); }
    setBusy(false);
  }, []);
  useEffect(() => { load(false); }, [load]);

  if (err) return <div style={{ padding: 30, color: C.down, fontFamily: C.mono, fontSize: 12 }}>Model failed: {err}</div>;
  if (!data) return <div style={{ padding: 30, color: C.dim, fontSize: 12 }}>Building inflation model… (first build fits the component models + backtest, ~10s)</div>;

  // Total input failure (e.g. SingStat blocked by a corporate firewall): the backend
  // returns {error, sources} instead of a model — flag it, never render defaults.
  const srcIssues = Object.entries(data.sources || {})
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v).slice(0, 70)}`);
  if (data.error) {
    return (
      <div style={{ padding: 30, maxWidth: 900, margin: "0 auto" }}>
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 11.5, lineHeight: 1.7 }}>
          <b>M1/M2 unavailable — {data.error}.</b><br />
          {srcIssues.length > 0 && <>Blocked sources: {srcIssues.join(" · ")}.<br /></>}
          The model needs the SingStat CPI component tables; corporate networks often block
          tablebuilder.singstat.gov.sg for Python while the browser gets through. Fix: set
          EXT_DATA_PROXY to the corporate proxy (e.g. http://proxy.corp:8080) and restart the
          backend. Nothing is proxied or defaulted in the meantime.
        </div>
      </div>
    );
  }

  const nc = data.nowcast || {};
  const bt = data.backtest || {};
  const ph = data.phillips || {};
  const lastPub = data.lastPublished || {};
  const cpiRow = (consensus || []).find((r) => r.key === "cpiYoY") || {};
  const coreRow = (consensus || []).find((r) => r.key === "coreYoY") || {};

  const detail = (nc.detail || []).filter((d) => d.mm != null);
  const sorted = [...detail].sort((a, b) => (b.contribution ?? -9) - (a.contribution ?? -9));

  // backtest chart traces
  const btRows = bt.rows || [];
  const btTrace = (key, name, color, dash) => ({
    x: btRows.map((r) => r.month), y: btRows.map((r) => r[key]),
    name, type: "scatter", mode: "lines", line: { color, width: 1.5, dash },
  });

  // phillips fitted + projection
  const fit = ph.fitted || [];
  const proj = ph.projection || [];
  const phTraces = [
    { x: fit.map((r) => r.month), y: fit.map((r) => r.actual), name: "MAS Core actual", type: "scatter", mode: "lines", line: { color: C.cyan, width: 1.6 } },
    { x: fit.map((r) => r.month), y: fit.map((r) => r.fitted), name: "Fitted", type: "scatter", mode: "lines", line: { color: C.violet, width: 1.2, dash: "dot" } },
    { x: proj.map((r) => r.month), y: proj.map((r) => r.coreYoY), name: "Projection (6m)", type: "scatter", mode: "lines+markers", line: { color: C.amber, width: 1.6, dash: "dash" }, marker: { size: 4 } },
  ];
  const dec = ph.decomposition || {};
  const decTrace = {
    type: "bar",
    x: Object.values(dec), y: Object.keys(dec), orientation: "h",
    marker: { color: [C.cyan, C.blue, C.amber, C.violet, C.dim] },
    hovertemplate: "%{y}: %{x:.2f}pp<extra></extra>",
  };

  return (
    <div style={{ padding: 14, maxWidth: 1500, margin: "0 auto" }}>
      {/* nowcast header */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat label={`M1 NOWCAST · ${nc.target || "—"}`} value={`${F(nc.headlineYoY, 2)}%`} sub="headline y/y, bottom-up" color={C.cyan} />
        <Stat label="M1 CORE" value={`${F(nc.coreYoY, 2)}%`} sub="MAS core y/y, bottom-up" color={C.cyan} />
        <Stat label="CONSENSUS" value={`${F(cpiRow.mean, 2)} / ${F(coreRow.mean, 1)}%`} sub={`headline / core · rel ${cpiRow.releaseDate || "—"}`} color={C.amber} />
        <Stat label="NAIVE (CARRY)" value={`${F(lastPub.headlineYoY, 2)} / ${F(lastPub.coreYoY, 1)}%`} sub={`= ${lastPub.month} y/y carried fwd`} />
        {(() => {  // surprise call vs consensus: only a "call" beyond ~½ RMSE
          const edgeH = nc.headlineYoY != null && cpiRow.mean != null ? nc.headlineYoY - cpiRow.mean : null;
          const edgeC = nc.coreYoY != null && coreRow.mean != null ? nc.coreYoY - coreRow.mean : null;
          const thr = (bt.rmse?.m1Headline ?? 0.25) / 2;
          const isCall = edgeH != null && Math.abs(edgeH) > thr;
          return <Stat label="SURPRISE CALL vs CONS" value={`${FP(edgeH, 2)} / ${FP(edgeC, 2)}`}
            sub={isCall ? `|edge| > ${thr.toFixed(2)} → ${edgeH > 0 ? "UPSIDE" : "DOWNSIDE"} call` : `inside ±${thr.toFixed(2)} noise band — no call`}
            color={isCall ? C.amber : C.dim} />;
        })()}
        <Stat label="BACKTEST RMSE 36M" value={`${F(bt.rmse?.m1Headline, 2)} vs ${F(bt.rmse?.naiveHeadline, 2)}`} sub="M1 vs naive · headline pp" color={bt.rmse && bt.rmse.m1Headline < bt.rmse.naiveHeadline ? C.up : C.down} />
        <Stat label="CORE RMSE" value={`${F(bt.rmse?.m1Core, 2)} vs ${F(bt.rmse?.naiveCore, 2)}`} sub="M1 vs naive · core pp" color={bt.rmse && bt.rmse.m1Core < bt.rmse.naiveCore ? C.up : C.down} />
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, alignItems: "flex-end" }}>
          <button onClick={() => load(true)} disabled={busy}
            style={{ background: C.panel2, color: C.cyan, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 14px", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", cursor: "pointer" }}>
            {busy ? "REBUILDING…" : "REBUILD"}
          </button>
          <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono }}>
            built {String(data.asOf).slice(5, 16)} · {data.buildSecs}s · recon {data.reconstruction ? `${data.reconstruction.diffPct}%` : "—"}
          </div>
        </div>
      </div>

      {srcIssues.length > 0 && (
        <div style={{ marginBottom: 10, padding: "7px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
          partial inputs — {srcIssues.join(" · ")} (affected components fall back to labelled seasonal; nothing proxied — see EXT_DATA_PROXY in the ⓘ manual if this network blocks SingStat)
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10, marginBottom: 10 }}>
        {/* component table */}
        <Panel title="COMPONENT NOWCAST" note={`${nc.target} · m/m forecast per component → y/y & contribution (pp of headline)`}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
              <thead>
                <tr style={{ color: C.dim, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>COMPONENT</th>
                  <th style={{ padding: "3px 6px" }}>W%</th>
                  <th style={{ padding: "3px 6px" }}>M/M</th>
                  <th style={{ padding: "3px 6px" }}>Y/Y</th>
                  <th style={{ padding: "3px 6px" }}>CONTRIB</th>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>METHOD</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((d) => (
                  <tr key={d.key} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right" }}>
                    <td style={{ textAlign: "left", padding: "3px 6px", color: d.core ? C.text : C.amber }}>{d.label}{!d.core && " ✕"}</td>
                    <td style={{ fontFamily: C.mono, padding: "3px 6px", color: C.dim }}>{(d.w / 100).toFixed(1)}</td>
                    <td style={{ fontFamily: C.mono, padding: "3px 6px" }}>{FP(d.mm, 2)}</td>
                    <td style={{ fontFamily: C.mono, padding: "3px 6px" }}>{FP(d.yoy, 1)}</td>
                    <td style={{ fontFamily: C.mono, padding: "3px 6px", color: (d.contribution ?? 0) >= 0 ? C.up : C.down }}>{FP(d.contribution, 2)}</td>
                    <td style={{ textAlign: "left", padding: "3px 6px", color: C.sub, fontSize: 9.5 }}>{d.method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 5, lineHeight: 1.5 }}>
            ✕ = excluded from MAS core. Methods: “seasonal” = median m/m of that calendar month (6y, ex-2020) — no driver.
            Driver overlays exist for utilities (SP tariff step: announced → realised → Brent-window est), private transport (COE),
            accommodation (URA rents) and food ex-FBS (FAO index); each is refit on data before its target (no lookahead) and
            r²-gated — a failed fit falls back to LABELLED seasonal rather than a noise model. A one-month-ahead y/y is ~11/12
            already-published base effects, so the M/M column is the only new information; the backtest-vs-naive RMSE is the
            evidence the overlays + seasonals together beat carrying last month forward.
          </div>
        </Panel>
        {/* backtest chart */}
        <Panel title="BACKTEST — HEADLINE Y/Y" note="expanding-window one-step-ahead, last 36 prints">
          <Lines id="sgm-bt" height={250} series={[
            btTrace("actualHeadline", "Actual", C.cyan),
            btTrace("m1Headline", "M1 nowcast", C.amber),
            btTrace("naiveHeadline", "Naive carry", C.dim, "dot"),
          ]} />
        </Panel>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="M2 — CORE PHILLIPS CURVE" note={`${ph.form || ""} · r² ${ph.r2 ?? "—"} · n ${ph.n ?? "—"} (fit 2012→)`}>
          <Lines id="sgm-ph" height={240} series={phTraces} />
        </Panel>
        <Panel title="DECOMPOSITION & PROJECTION" note={`latest month's core y/y by term (coef × value, pp) · ${ph.lastMonth || ""}`}>
          <Plot data={[decTrace]}
            layout={chartLayout("sgm-dec", { height: 150, margin: { l: 90, r: 12, t: 8, b: 22 }, xaxis: { zeroline: true } })}
            config={PCFG} style={{ width: "100%" }} useResizeHandler />
          <div style={{ fontFamily: C.mono, fontSize: 10, color: C.sub, marginTop: 6, lineHeight: 1.6 }}>
            {(ph.projection || []).map((p) => `${p.month.slice(5)}: ${p.coreYoY}%`).join(" · ")}
          </div>
          <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>
            Projection holds import-price & NEER y/y at last obs; IP gap decays 0.9/m. GST dummies: Jan-23, Jan-24.
          </div>
        </Panel>
      </div>

      <Panel title="SURPRISE SCORECARD — MODEL vs CONSENSUS vs ACTUAL" note="recorded forward each release (vendor stores no consensus history)" style={{ marginBottom: 10 }}>
        {(data.surpriseLog?.rows || []).length === 0
          ? <div style={{ padding: 14, color: C.dim, fontSize: 11 }}>
              No scored prints yet — logging started with the Jul-2026 release (24 Aug 2026). Each month this table gains a row:
              consensus (frozen pre-release), the model's call, the actual, and whether the model called the surprise direction.
            </div>
          : <>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10.5 }}>
                <thead><tr style={{ color: C.dim, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "3px 6px" }}>MONTH</th><th style={{ textAlign: "left" }}>SERIES</th>
                  <th style={{ padding: "3px 6px" }}>CONS</th><th style={{ padding: "3px 6px" }}>MODEL</th>
                  <th style={{ padding: "3px 6px" }}>ACTUAL</th><th style={{ padding: "3px 6px" }}>SURPRISE</th>
                  <th style={{ padding: "3px 6px" }}>MODEL−CONS</th><th style={{ padding: "3px 6px" }}>HIT</th>
                </tr></thead>
                <tbody>
                  {data.surpriseLog.rows.map((r) => (
                    <tr key={r.month + r.series} style={{ borderTop: `1px solid ${C.border}`, textAlign: "right", fontFamily: C.mono }}>
                      <td style={{ textAlign: "left", padding: "3px 6px" }}>{r.month}</td>
                      <td style={{ textAlign: "left", color: C.sub }}>{r.series === "cpiYoY" ? "headline" : "core"}</td>
                      <td style={{ padding: "3px 6px" }}>{F(r.consensus, 2)}</td>
                      <td style={{ padding: "3px 6px" }}>{F(r.model, 2)}</td>
                      <td style={{ padding: "3px 6px", color: C.text }}>{F(r.actual, 2)}</td>
                      <td style={{ padding: "3px 6px", color: r.surprise > 0 ? C.up : r.surprise < 0 ? C.down : C.sub }}>{FP(r.surprise, 2)}</td>
                      <td style={{ padding: "3px 6px" }}>{FP(r.modelMinusCons, 2)}</td>
                      <td style={{ padding: "3px 6px" }}>{r.hit == null ? "—" : r.hit ? "✓" : "✗"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 9.5, color: C.sub, fontFamily: C.mono, marginTop: 5 }}>
                surprise-direction hit rate: {data.surpriseLog.hitRate != null ? `${Math.round(data.surpriseLog.hitRate * 100)}%` : "—"} over {data.surpriseLog.n} scored rows
              </div>
            </>}
        <div style={{ fontSize: 9, color: C.dim, marginTop: 5 }}>{data.surpriseLog?.note}</div>
      </Panel>

      <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, paddingBottom: 20 }}>
        M1 = Laspeyres aggregation, DOS 2024 weights (headline = Σ wᵢIᵢ/10000; core = Σ_core wᵢIᵢ/Σ_core wᵢ; reconstruction check {data.reconstruction ? `${data.reconstruction.diffPct}% vs official` : "—"}) ·
        drivers: SP tariff step (announced → realised → Brent-window est) × estimated pass-through, COE bidding premiums (data.gov.sg), URA rent lags 3–6q, FAO food lags 4–9m ·
        M2 per BIS Papers 142 (MAS EPG) · cached 6h
      </div>
    </div>
  );
}

// ═══════════════════════ POLICY sub-tab ═══════════════════════
function PolicyView({ monitor }) {
  const [model, setModel] = useState(null);
  useEffect(() => {
    fetch("/api/fund/sg/model").then((r) => r.json()).then(setModel).catch(() => {});
  }, []);
  if (!monitor) return <div style={{ padding: 30, color: C.dim, fontSize: 12 }}>Loading…</div>;
  const pol = monitor.policy || {};
  const act = monitor.activity || {};
  const vint = (monitor.inflation || {}).forecastVintages2026 || [];
  const rp = model?.policy?.reactionPrior;
  const spfN = model?.policy?.spfNextMeeting;
  const proj = model?.phillips?.projection || [];
  // Phillips path direction computed from the live projection — never hardcoded prose.
  const projDir = proj.length >= 2 && proj[0].coreYoY != null && proj[proj.length - 1].coreYoY != null
    ? (proj[proj.length - 1].coreYoY - proj[0].coreYoY > 0.05 ? "rising"
       : proj[proj.length - 1].coreYoY - proj[0].coreYoY < -0.05 ? "falling" : "flat")
    : null;

  return (
    <div style={{ padding: 14, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat label="NEXT MPS" value="≤ 14 Oct 2026" sub="quarterly · MR same day" color={C.amber} />
        <Stat label="REACTION PRIOR" value={rp?.read ? rp.read.toUpperCase() : "—"} sub={rp?.read ? `core gap ${FP(rp.coreGap, 2)}pp · output gap ${FP(act.outputGap2026 ?? rp.outputGap, 1)}%` : "from model (unavailable until nowcast builds)"} color={C.cyan} />
        <Stat label="SPF: OCT SLOPE ↑" value={spfN ? `${spfN.slopeUpPct}%` : "—"} sub="of respondents (Jun-26 survey)" />
        <Stat label="M2 CORE @ OCT MPS" value={proj.length >= 3 ? `${proj[2].coreYoY}%` : "—"} sub="Phillips projection for Sep y/y" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="POLICY REACTION FRAMEWORK" note="MR Oct-2018 Box A · MR Oct-2021 SF A">
          <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.7 }}>
            <p style={{ margin: "4px 0" }}>MAS's estimated rule: <span style={{ color: C.text }}>band slope ← core-inflation gap (vs ~2% medium-term) + output gap</span>. Estimated sensitivities: +1pp expected inflation → +1.7% NEER appreciation; +1pp output gap → +0.9%.</p>
            <p style={{ margin: "4px 0" }}>Current inputs: core nowcast <span style={{ fontFamily: C.mono, color: C.cyan }}>{model?.nowcast?.coreYoY ?? "—"}%</span> (gap {rp?.coreGap != null ? FP(rp.coreGap, 2) : "—"}pp), output gap <span style={{ fontFamily: C.mono, color: C.cyan }}>{act.outputGap2026 != null ? FP(act.outputGap2026, 1) + "%" : "—"}</span> (MR Jul-26), Phillips path {projDir ? `${projDir} over the projection` : "— (model unavailable)"} → <span style={{ color: C.amber, fontWeight: 700 }}>{rp?.read || "—"}</span>.</p>
            <p style={{ margin: "4px 0", color: C.dim, fontSize: 10 }}>{spfN?.note}</p>
          </div>
        </Panel>
        <Panel title="2026 FORECAST VINTAGES" note="MAS core & headline range, by statement">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <tbody>
              {vint.map((v) => (
                <tr key={v.asOf} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ fontFamily: C.mono, color: C.dim, padding: "4px 6px" }}>{v.asOf}</td>
                  <td style={{ fontFamily: C.mono, color: C.text, padding: "4px 6px" }}>{v.low}–{v.high}%</td>
                  <td style={{ color: C.sub, padding: "4px 6px", fontSize: 10 }}>{v.low === 1.5 && v.asOf === "2026-04-14" ? "raised (energy shock)" : v.asOf === "2026-01-29" ? "raised" : v.asOf === "2026-07-27" ? "held" : "baseline"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>
            SPF Jun-26 medians sit at {pol.spf?.cpi2026}% headline / {pol.spf?.core2026}% core — upper half of the MAS range.
          </div>
        </Panel>
      </div>
      <Panel title="MPS DECISION HISTORY" note="slope / width / centre — since 2016">
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <tbody>
              {[...(pol.decisions || [])].reverse().map((d) => (
                <tr key={d.date} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ fontFamily: C.mono, color: C.dim, padding: "3px 6px", width: 110 }}>{d.date}</td>
                  <td style={{ color: d.action.includes("↑") ? C.up : d.action.includes("↓") || d.action.includes("0%") ? C.down : C.sub, padding: "3px 6px" }}>{d.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ═══════════════════════ NOWCAST sub-tab ═══════════════════════
// Tier-A high-frequency feeds that lead the monthly CPI print (plan §2).
function NowcastView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/fund/sg/nowcast${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setData(await r.json());
    } catch (e) { setErr(String(e).slice(0, 300)); }
    setBusy(false);
  }, []);
  useEffect(() => { load(false); }, [load]);

  if (err) return <div style={{ padding: 30, color: C.down, fontFamily: C.mono, fontSize: 12 }}>Nowcast failed: {err}</div>;
  if (!data) return <div style={{ padding: 30, color: C.dim, fontSize: 12 }}>Loading high-frequency trackers…</div>;

  const t = data.tariff || {};
  const staleSrc = [["coe", data.coe], ["fao", data.fao], ["hdbRent", data.hdbRent]]
    .filter(([, v]) => v?.stale || v?.error).map(([k]) => k);
  const coeH = data.coe?.history || {};
  const coeLatest = data.coe?.latest || {};
  const coeTraces = [["Category A", C.cyan], ["Category B", C.blue], ["Category E", C.violet]]
    .filter(([k]) => coeH[k])
    .map(([k, col]) => ({ x: coeH[k].exercises.map(exLabel), y: coeH[k].premiums, name: k.replace("Category", "Cat"),
      type: "scatter", mode: "lines+markers", line: { color: col, width: 1.4 }, marker: { size: 3 } }));
  const winShapes = [
    { type: "rect", xref: "x", yref: "paper", x0: t.windowForCurrent?.from, x1: t.windowForCurrent?.to, y0: 0, y1: 1, fillcolor: "rgba(148,163,184,0.10)", line: { width: 0 } },
    { type: "rect", xref: "x", yref: "paper", x0: t.windowForNext?.from, x1: t.windowForNext?.to, y0: 0, y1: 1, fillcolor: "rgba(34,211,238,0.10)", line: { width: 0 } },
  ];

  return (
    <div style={{ padding: 14, maxWidth: 1500, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <Stat label="TARIFF NOW" value={`${t.currentTariffCents}¢`} sub={`${t.asOf} · energy ${t.energyComponentCents}¢`} color={C.amber} />
        <Stat label="NEXT-Q TARIFF EST" value={t.estNextStepPct != null ? `${FP(t.estNextStepPct, 1)}%` : "—"} sub={`window ${t.windowForNext?.daysIn}d in · Brent ${F(t.windowForNext?.brentAvgSoFar, 1)} vs ${F(t.windowForCurrent?.brentAvg, 1)}`} color={C.cyan} />
        <Stat label="BRENT" value={data.brent?.values?.length ? F(data.brent.values[data.brent.values.length - 1], 2) : "—"} sub="LCOc1 · drives tariff + imported energy" />
        <Stat label="FAO FOOD Y/Y" value={data.fao?.yoy?.values?.length ? `${FP(data.fao.yoy.values[data.fao.yoy.values.length - 1], 1)}%` : "—"} sub={`index ${data.fao?.index?.values?.length ? F(data.fao.index.values[data.fao.index.values.length - 1], 1) : "—"} · feeds food CPI via import prices`} />
        <Stat label="HDB 4RM RENT Y/Y" value={data.hdbRent?.yoy?.values?.length ? `${FP(data.hdbRent.yoy.values[data.hdbRent.yoy.values.length - 1], 1)}%` : "—"} sub="avg of town medians · leads accommodation 4–8q" />
        <Stat label="COE CAT A" value={coeLatest["Category A"] ? `${Math.round(coeLatest["Category A"].premium / 1000)}k` : "—"} sub={`latest ${coeLatest["Category A"] ? exLabel(coeLatest["Category A"].exercise) : "—"}`} />
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, alignItems: "flex-end" }}>
          <button onClick={() => load(true)} disabled={busy}
            style={{ background: C.panel2, color: C.cyan, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 14px", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", cursor: "pointer" }}>
            {busy ? "REFRESHING…" : "REFRESH"}
          </button>
          <div style={{ fontSize: 8.5, color: staleSrc.length ? C.amber : C.dim, fontFamily: C.mono }}>
            built {String(data.asOf).slice(5, 16)} · {data.buildSecs}s{staleSrc.length ? ` · stale: ${staleSrc.join(",")}` : ""}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="BRENT & THE TARIFF-SETTING WINDOWS" note="grey = window that SET the current tariff · cyan = window forming the NEXT one"
          right={<Chip on>M1 INPUT · utilities — est until SP announces</Chip>}>
          <Lines id="sgn-brent" height={230} ytitle="$/bbl" yzero={false} shapes={winShapes}
            series={[line(data.brent, "Brent (LCOc1)", C.amber)]} />
          <div style={{ fontSize: 9.5, color: C.sub, marginTop: 4 }}>{t.note}</div>
        </Panel>
        <Panel title="COE PREMIUMS" note="per bidding exercise #1/#2 (dataset: month + exercise no., not auction dates)"
          right={<Chip on>M1 INPUT · private transport</Chip>}>
          {coeTraces.length
            ? <Lines id="sgn-coe" height={250} ytitle="S$" yzero={false} series={coeTraces} xover={COE_XAXIS} />
            : <Missing what="COE bidding results (data.gov.sg)" err={data.coe?.error} height={250} />}
        </Panel>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Panel title="FAO FOOD PRICE INDEX" note="y/y % · 0.63 LR pass-through to food import prices; →CPI ~half within 4q (MR Apr-17 Box B)"
          right={<Chip on>M1 INPUT · food (r²-gated)</Chip>}>
          {data.fao?.yoy?.values?.length
            ? <Lines id="sgn-fao" height={190} series={[line(data.fao?.yoy, "FAO food y/y", C.cyan)]} />
            : <Missing what="FAO food price index (fao.org)" err={data.fao?.error} height={190} />}
        </Panel>
        <Panel title="HDB RENTS" note="avg of town median 4-room rents, quarterly → accommodation CPI with 4–8q lag"
          right={<Chip>MONITOR ONLY · M1 uses URA index</Chip>}>
          {data.hdbRent?.avgMedian4rm?.values?.length
            ? <Lines id="sgn-hdb" height={190} ytitle="S$/mo" yzero={false} series={[line(data.hdbRent?.avgMedian4rm, "Avg median 4rm", C.cyan)]} />
            : <Missing what="HDB median rents (data.gov.sg)" err={data.hdbRent?.error} height={190} />}
        </Panel>
        <Panel title="JET FUEL (SGP FOB SWAP)" note="drives airfares / travel services"
          right={<Chip>MONITOR ONLY</Chip>}>
          {data.jetFuel
            ? <Lines id="sgn-jet" height={190} ytitle="$/bbl" yzero={false} series={[line(data.jetFuel, "Jet fuel M1 swap", C.violet)]} />
            : <div style={{ padding: 24, color: C.dim, fontSize: 11 }}>JETSGSWMc1 history not entitled on this Workspace — showing nothing rather than a proxy.</div>}
        </Panel>
      </div>
      <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, paddingBottom: 20 }}>
        Known gaps: {(data.gaps || []).join(" · ")} · All feeds cached 6h, no polling.
      </div>
    </div>
  );
}

// ═══════════════════════ parent: sub-tab shell ═══════════════════════
export default function SgFundamentals() {
  const [tab, setTab] = useState("monitor");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/fund/sg${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setData(await r.json());
    } catch (e) { setErr(String(e).slice(0, 300)); }
    setBusy(false);
  }, []);
  useEffect(() => { load(false); }, [load]);

  const SUBTABS = [["monitor", "MONITOR"], ["model", "MODEL"], ["nowcast", "NOWCAST"], ["policy", "POLICY"]];
  return (
    <div>
      <div style={{ display: "flex", gap: 2, padding: "6px 14px 0", borderBottom: `1px solid ${C.border}`, background: C.bg, alignItems: "center" }}>
        {SUBTABS.map(([id, lbl]) => {
          const on = tab === id;
          return (
            <button key={id} onClick={() => setTab(id)}
              style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".1em", padding: "8px 16px",
                       background: "transparent", border: "none", cursor: "pointer",
                       color: on ? C.cyan : C.dim, borderBottom: `2px solid ${on ? C.cyan : "transparent"}` }}>
              {lbl}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <InfoButton docKey={`fund.${tab}`} />
      </div>
      {tab === "monitor" ? <MonitorView data={data} err={err} busy={busy} load={load} />
        : tab === "model" ? <ModelView consensus={data?.consensus?.rows} />
        : tab === "nowcast" ? <NowcastView />
        : <PolicyView monitor={data} />}
    </div>
  );
}
