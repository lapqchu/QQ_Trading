// EM Rules — Willer/Chandran/Lam screener (5th deep-dive tab).
//
// Screens the EM universe (pricer 33 + BR) against the book's backtested rules:
// per-country R1 cycle turn, R2 inflation peaked, R3 real-rate rank, R4 term
// premium, R5 curve, R8 momentum/breadth, R11 stress preconditions — plus the
// global overlays R6 (vol z), R9 (UST), R10 (CNH 12M). Carry (R7) is read live
// from the Carry Basket service. One fetch on mount (backend caches 12h) + a
// manual rebuild; this tab never polls.
import React, { useEffect, useState, useCallback } from "react";
import { F, FP } from "../calc.js";
import { InfoButton } from "./InfoDoc.jsx";

const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

function Chip({ text, tone }) {
  const col = tone === "up" ? C.up : tone === "down" ? C.down : tone === "warn" ? C.amber : C.dim;
  return (
    <span style={{ fontFamily: C.mono, fontSize: 9.5, fontWeight: 700, color: col,
                   border: `1px solid ${col}44`, background: `${col}14`,
                   borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

// Substitution marker: ° = a different official/market series stands in (its own
// country's convention), † = a value DERIVED by market convention from real inputs.
// Hover shows the reason; the ⓘ manual carries the full substitution table.
function Mark({ meta }) {
  if (!meta || !meta.note) return null;
  return (
    <span title={meta.note}
      style={{ color: C.amber, fontSize: 9, cursor: "help", marginLeft: 2, fontWeight: 800 }}>
      {meta.kind === "derived" ? "†" : "°"}
    </span>
  );
}

function GCard({ label, value, state, bad, warn, sub }) {
  const col = bad ? C.down : warn ? C.amber : null;
  return (
    <div style={{ background: C.panel, border: `1px solid ${col || C.border}`, borderRadius: 8, padding: "8px 12px", minWidth: 150 }}>
      <div style={{ fontSize: 9, letterSpacing: ".1em", color: C.dim, fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 600, color: col || C.text, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 9, color: col || C.sub, marginTop: 1 }}>{state}{sub ? ` · ${sub}` : ""}</div>
    </div>
  );
}

const REGION_ORDER = ["Latam", "CEEMEA", "Asia", "GCC", "Africa"];

export default function EmRules() {
  const [data, setData] = useState(null);
  const [carry, setCarry] = useState({});
  const [carryErr, setCarryErr] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/rules${refresh ? "?refresh=1" : ""}`);
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      setData(await r.json());
    } catch (e) { setErr(String(e).slice(0, 300)); }
    setBusy(false);
  }, []);
  useEffect(() => { load(false); }, [load]);
  useEffect(() => {   // R7 carry from the Carry Basket service (cached 90s server-side)
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/carry/rank");
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) {   // no-proxy rule: a failed rank must be visible, not a silent "—" column
          setCarryErr((j && (j.detail || j.error)) || `HTTP ${r.status}`);
          return;
        }
        const list = j.rows || j.rank || j.ranked || [];
        const m = {};
        list.forEach((r2) => { const k = r2.ccy || r2.code; if (k) m[k] = r2; });
        setCarry(m); setCarryErr(null);
      } catch (e) { if (alive) setCarryErr(e?.message || "network error"); }
    };
    load();
    const retry = setTimeout(load, 60000);   // one retry covers a transient rank outage; server-cached so it's cheap
    return () => { alive = false; clearTimeout(retry); };
  }, []);

  if (err) return <div style={{ padding: 30, color: C.down, fontFamily: C.mono, fontSize: 12 }}>EM Rules failed: {err}</div>;
  if (!data) return <div style={{ padding: 30, color: C.dim, fontSize: 12 }}>Building EM rules screen… (first build pulls ~150 daily histories, ~40s)</div>;

  const g = data.global || {};
  const rows = [...(data.countries || [])].sort((a, b) => {
    const ra = REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region);
    if (ra !== 0) return ra;
    return (a.r3?.rank ?? 99) - (b.r3?.rank ?? 99);
  });
  const nRanked = rows.filter((r) => r.r3?.rank != null).length;

  const th = { textAlign: "right", padding: "4px 7px", whiteSpace: "nowrap", position: "sticky", top: 0, background: C.panel2, zIndex: 2, fontSize: 9, letterSpacing: ".06em", color: C.dim };
  const td = { textAlign: "right", padding: "3px 7px", whiteSpace: "nowrap", fontFamily: C.mono, fontSize: 10.5 };

  return (
    <div style={{ padding: 14, maxWidth: 1560, margin: "0 auto" }}>
      {/* global overlays */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "stretch" }}>
        <GCard label="R6 · RISK OVERLAY" value={g.r6?.maxZ != null ? `z ${g.r6.maxZ}` : "—"}
          state={g.r6?.state} bad={g.r6?.state === "CUT EXPOSURE"} warn={g.r6?.state === "no data"}
          sub={["realized-vol proxy", ...Object.entries(g.r6?.z || {}).map(([k, v]) => `${k} ${v}`)].join(" · ")} />
        <GCard label="R9 · UST 10Y Δ3M" value={g.r9?.ust3mBp != null ? `${FP(g.r9.ust3mBp, 0)}bp` : "—"}
          state={g.r9?.state} bad={g.r9?.state === "EMFX NEGATIVE"} warn={g.r9?.state === "no data"}
          sub=">+100bp = EMFX negative" />
        <GCard label="R10 · CNH 12M FWD" value={g.r10?.cnh12mPct != null ? `${FP(g.r10.cnh12mPct, 2)}%` : "—"}
          state={g.r10?.state} bad={g.r10?.state === "EXTENDED SHORTS"} warn={g.r10?.state === "no data"}
          sub=">+5% dep = extended shorts" />
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, alignItems: "flex-end" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <InfoButton docKey="rules" />
            <button onClick={() => load(true)} disabled={busy}
              style={{ background: C.panel2, color: C.cyan, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 14px", fontSize: 10, fontWeight: 800, letterSpacing: ".08em", cursor: "pointer" }}>
              {busy ? "REBUILDING…" : "REBUILD"}
            </button>
          </div>
          <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono }}>built {String(data.asOf).slice(5, 16)} · {data.buildSecs}s · cached 12h</div>
        </div>
      </div>

      {carryErr && (
        <div style={{ marginBottom: 10, padding: "7px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
          CARRY column unavailable — {carryErr} (Carry Basket rank service; "—" below means unfetched, not unpriced)
        </div>
      )}

      {/* the matrix */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "auto", maxHeight: "72vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1320 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", left: 0, zIndex: 3, position: "sticky", background: C.panel2 }}>COUNTRY</th>
              <th style={th}>POLICY</th>
              <th style={th}>CPI Y/Y</th>
              <th style={th}>CORE</th>
              <th style={th} title="R1: 1Y swap − policy. Receive when the 1Y crosses below policy (easing priced); pay into hikes.">R1 CYCLE</th>
              <th style={th} title="R2: EM CBs stop hiking the same month inflation peaks.">R2 PEAK</th>
              <th style={th} title="R3: policy − CPI y/y">REAL</th>
              <th style={th} title="R3: policy − target midpoint (book's preferred deflator). Rank across universe.">vs TGT · RK</th>
              <th style={th} title="R4: z-score of (5Y − policy) over rolling 3m. >1σ → receive 5Y.">R4 TP·z</th>
              <th style={th} title="R5: curve slope bp + 3m change. Steepeners work before first cut.">R5 CURVE</th>
              <th style={th} title="R7: 1M fwd-implied yield − SOFR (Carry Basket service)">CARRY</th>
              <th style={th} title="R8: 1M FX appreciation vs USD; up-days of 21">R8 MOM</th>
              <th style={th} title="R11: |daily ret|>1σ days in trailing 100d. >30 = stressed. Emergency-hike precondition = stressed AND cheap on REER (next column) — a defensive hike only rescues a stressed AND cheap currency.">R11 σ</th>
              <th style={th} title="Real effective exchange rate vs its 10y average (BIS real broad index; IMF-style for NG/MA/TN/UG). Negative (green) = cheap — competitiveness tailwind and R11's second precondition; positive (red) = rich. None exists for KZ/QA/EG/MU/BW.">REER</th>
              <th style={th}>CDS</th>
              <th style={th} title="HOUSE composite (not from the book): rule votes — R1 RECEIVE +2 / PAY −2 · R2 peaked +1 / rising −1 / flat 0 · R3 rank top-3 +1 / bottom-3 −1 · R4 z>1 +1 · R11 stressed −1 (σ-count half only — the REER precondition is unbuilt). Positive = receive bias, negative = pay bias.">SCORE</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const r1 = r.r1, r2 = r.r2, r3 = r.r3 || {}, r4 = r.r4, r5 = r.r5, r8 = r.r8, r11 = r.r11;
              const cr = carry[r.ccy];
              const newRegion = i === 0 || rows[i - 1].region !== r.region;
              const rankTone = r3.rank == null ? undefined : r3.rank <= 3 ? "up" : r3.rank > nRanked - 3 ? "down" : undefined;
              return (
                <React.Fragment key={r.cc}>
                  {newRegion && (
                    <tr><td colSpan={16} style={{ padding: "5px 8px 2px", fontSize: 9, fontWeight: 800, letterSpacing: ".14em", color: C.cyan, background: C.bg, position: "sticky", left: 0 }}>{r.region.toUpperCase()}</td></tr>
                  )}
                  <tr style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ ...td, textAlign: "left", position: "sticky", left: 0, background: C.panel, zIndex: 1 }}>
                      <span style={{ color: C.text, fontWeight: 700 }}>{r.ccy}</span>
                      <span style={{ color: C.dim, fontSize: 9, marginLeft: 6 }}>{r.name}</span>
                      {r.note && <span title={r.note} style={{ color: C.amber, marginLeft: 4 }}>*</span>}
                    </td>
                    <td style={td}>{F(r.policy, 2)}</td>
                    <td style={td}>{F(r.cpiYoY, 2)}</td>
                    <td style={{ ...td, color: C.sub }}>{F(r.core, 1)}<Mark meta={r.coreMeta} /></td>
                    <td style={td}>
                      {r1 ? <Chip text={`${r1.state} ${FP(r1.gap1y, 2)}${r1.since ? " · " + r1.since : ""}`}
                                  tone={r1.state === "RECEIVE" ? "up" : r1.state === "PAY" ? "down" : undefined} /> : "—"}
                      <Mark meta={r.curveMeta} />
                    </td>
                    <td style={td}>{r2 ? <Chip text={r2.peaked ? "PEAKED" : r2.rising ? "rising" : "flat"} tone={r2.peaked ? "up" : r2.rising ? "warn" : undefined} /> : "—"}</td>
                    <td style={{ ...td, color: (r3.real ?? 0) >= 0 ? C.text : C.down }}>{FP(r3.real, 2)}</td>
                    <td style={td}>
                      {r3.realVsTarget != null ? FP(r3.realVsTarget, 2) : "—"}
                      {r3.rank != null && <span style={{ marginLeft: 5 }}><Chip text={`#${r3.rank}`} tone={rankTone} /></span>}
                    </td>
                    <td style={{ ...td, color: (r4?.z3m ?? 0) > 1 ? C.up : C.sub }}>
                      {r4 ? `${F(r4.tp, 2)} · z${FP(r4.z3m, 1)}` : "—"}<Mark meta={r.curveMeta} />
                    </td>
                    <td style={{ ...td, color: C.sub }}>{r5 ? `${r5.pair} ${FP(r5.slopeBp, 0)} (${FP(r5.chg3mBp, 0)})` : "—"}{r5 ? <Mark meta={r.curveMeta} /> : null}</td>
                    <td style={{ ...td, color: C.sub }}>{cr && cr.carry != null ? FP(cr.carry, 2) : "—"}</td>
                    <td style={{ ...td, color: (r8?.mom1m ?? 0) >= 0 ? C.up : C.down }}>
                      {r8 ? `${FP(r8.mom1m, 1)}% · ${r8.upDays21}/21` : "—"}
                    </td>
                    <td style={td} title={r11?.preconditionMet != null ? `emergency-hike precondition ${r11.preconditionMet ? "MET (stressed + cheap REER)" : "not met"}` : undefined}>
                      {r11 ? <Chip text={String(r11.sigmaMoves100d)} tone={r11.preconditionMet ? "down" : r11.stressed ? "warn" : undefined} /> : "—"}
                    </td>
                    <td style={{ ...td, color: r.reer ? (r.reer.cheap ? C.up : C.down) : C.dim }}>
                      {r.reer ? `${FP(r.reer.vs10yPct, 0)}%` : "—"}<Mark meta={r.reerMeta} />
                    </td>
                    <td style={{ ...td, color: C.sub }}>{F(r.cds, 0)}</td>
                    <td style={td} title={r.score ? Object.entries(r.score.parts).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(" · ") : "no rules computed"}>
                      {r.score
                        ? <Chip text={`${r.score.total > 0 ? "+" : ""}${r.score.total}${r.score.total >= 2 ? " REC" : r.score.total <= -2 ? " PAY" : ""}`}
                                tone={r.score.total >= 2 ? "up" : r.score.total <= -2 ? "down" : undefined} />
                        : "—"}
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, padding: "10px 2px 20px", lineHeight: 1.6 }}>
        {(data.notes || []).join(" · ")}<br />
        Source: Willer/Chandran/Lam, <i>Trading Fixed Income and FX in Emerging Markets</i> — rules digested in the em-macro-trader skill; RIC map in SG_FUNDAMENTALS_PLAN.md §3.
      </div>
    </div>
  );
}
