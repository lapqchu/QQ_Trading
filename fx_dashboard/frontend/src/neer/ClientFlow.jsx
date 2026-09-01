// CLIENT FLOW — deep-dive tab over the periodically-uploaded client-flow export.
//
// The export is a long CSV of (pair, client type, timestamp, cumulative USD mio)
// with an unknown anchor: every level is RELATIVE, per-bucket flow is the first
// difference, and the backend's derived-flow engine states every diff
// (ok/close/overnight/offGrid/gapSpanned/seam) so each panel admits only what it
// can use honestly. House rules: no proxy data (blank + flag), truncations always
// visible, direction wording gated on the one-time sign-convention confirmation.
//
//   POST /api/flow/upload/preview|commit|revert    ingest (two-phase, revertable)
//   GET  /api/flow/status · /api/flow/analytics/{panel}
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { InfoButton } from "./InfoDoc.jsx";

// ── Dark theme (mirrors NeerApp / CarryBasket / the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

const fm = (v, dp = 1) => (v == null || !isFinite(v)) ? "—" : v.toFixed(dp);
const fsgn = (v, dp = 1) => (v == null || !isFinite(v)) ? "—" : (v > 0 ? "+" : "") + v.toFixed(dp);
const zColor = (z) => z == null ? C.dim : z > 0 ? C.up2 : C.down;

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

function Seg({ options, value, onChange, small }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map(([id, lbl]) => {
        const on = value === id;
        return (
          <button key={String(id)} onClick={() => onChange(id)} style={{
            flex: 1, fontSize: small ? 9.5 : 10, fontWeight: 800, fontFamily: C.mono,
            padding: small ? "5px 6px" : "6px 8px", borderRadius: 5, cursor: "pointer",
            background: on ? "rgba(34,211,238,0.14)" : C.panel2,
            border: `1px solid ${on ? C.cyan : C.border}`, color: on ? C.cyan : C.sub,
            whiteSpace: "nowrap",
          }}>{lbl}</button>
        );
      })}
    </div>
  );
}

function WarnStrip({ color = C.amber, children }) {
  return (
    <div style={{ padding: "8px 11px", borderRadius: 6, background: `${color}1A`,
                  border: `1px solid ${color}55`, color, fontSize: 10, fontWeight: 600, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function MetaFooter({ meta }) {
  if (!meta) return null;
  const rng = meta.effectiveRange;
  return (
    <div style={{ fontSize: 8, color: C.dim, marginTop: 8, fontFamily: C.mono, lineHeight: 1.6 }}>
      {rng ? `showing ${rng[0]?.slice(0, 10)} → ${rng[1]?.slice(0, 10)} · ` : ""}n={meta.n}
      {(meta.flags || []).map((f, i) => (
        <span key={i} style={{ color: f.code === "INSUFFICIENT" ? C.amber : C.dim }}>
          {" · "}{f.code.toLowerCase()}{f.count != null ? `:${f.count}` : ""}{f.detail ? ` (${f.detail})` : ""}
        </span>
      ))}
    </div>
  );
}

const plotBase = {
  paper_bgcolor: C.panel, plot_bgcolor: C.panel2,
  font: { color: C.sub, size: 9, family: "Inter,system-ui" },
  margin: { l: 46, r: 14, t: 8, b: 26 }, hovermode: "x unified",
  xaxis: { gridcolor: C.border, tickfont: { size: 8 }, automargin: true },
  yaxis: { gridcolor: C.border, zerolinecolor: "#475569", zeroline: true, tickfont: { size: 8 }, automargin: true },
};
const plotCfg = { responsive: true, displayModeBar: false, displaylogo: false };

async function getPanel(panel, params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v != null && v !== "") qs.set(k, v); });
  const r = await fetch(`/api/flow/analytics/${panel}?${qs}`);
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.detail || j.error)) || `HTTP ${r.status}`);
  return j;
}

function usePanel(panel, params, deps) {
  const [state, setState] = useState({ loading: true, res: null, err: null });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, err: null }));
    getPanel(panel, params)
      .then((res) => alive && setState({ loading: false, res, err: null }))
      .catch((e) => alive && setState({ loading: false, res: null, err: e?.message || "error" }));
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// ═══════════════════════════ main component ═══════════════════════════
export default function ClientFlow() {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const version = status?.storeVersion ?? -1;

  const loadStatus = useCallback(() => {
    fetch("/api/flow/status")
      .then(async (r) => { const j = await r.json().catch(() => null);
        if (!r.ok) { setStatusErr((j && j.detail) || `HTTP ${r.status}`); return; }
        setStatus(j); setStatusErr(null); })
      .catch((e) => setStatusErr(e?.message || "network error"));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  // ── selectors ──
  const pairs = useMemo(() => Object.keys(status?.coverage || {}).sort(), [status]);
  const [pair, setPair] = useState(null);
  useEffect(() => { if (!pair && pairs.length) setPair(pairs[0]); }, [pairs, pair]);
  const ctypes = useMemo(() => {
    const m = status?.coverage?.[pair] || {};
    return Object.entries(m).map(([k, v]) => ({ key: k, label: v.label,
      isAgg: k === "all client types" }));
  }, [status, pair]);
  const [ck, setCk] = useState("all client types");
  useEffect(() => {
    if (ctypes.length && !ctypes.some((t) => t.key === ck)) setCk(ctypes[0].key);
  }, [ctypes, ck]);
  const [weeks, setWeeks] = useState(26);

  const sign = status?.signConvention || "unconfirmed";
  const signSuffix = sign === "unconfirmed" ? " (+ = unconfirmed direction)" : (sign === "pos_buys_usd" ? " (+ = clients buy USD)" : " (+ = clients sell USD)");
  const empty = pairs.length === 0;

  // ── upload flow ──
  const [preview, setPreview] = useState(null);
  const [uploadErr, setUploadErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const doPreview = useCallback(async (file) => {
    setBusy(true); setUploadErr(null); setPreview(null);
    try {
      const r = await fetch(`/api/flow/upload/preview?filename=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.detail) || `HTTP ${r.status}`);
      setPreview(j);
    } catch (e) { setUploadErr(e?.message || "upload failed"); }
    finally { setBusy(false); }
  }, []);

  const doCommit = useCallback(async () => {
    if (!preview?.sha) return;
    setBusy(true);
    try {
      const r = await fetch("/api/flow/upload/commit", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha: preview.sha }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.detail) || `HTTP ${r.status}`);
      setPreview(null); loadStatus();
    } catch (e) { setUploadErr(e?.message || "commit failed"); }
    finally { setBusy(false); }
  }, [preview, loadStatus]);

  const doRevert = useCallback(async (uploadId) => {
    if (!window.confirm(`Revert upload #${uploadId}? Restores overwritten values and deletes rows it added.`)) return;
    const r = await fetch("/api/flow/upload/revert", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadId }) });
    if (r.ok) loadStatus();
  }, [loadStatus]);

  const setSign = useCallback(async (v) => {
    await fetch("/api/flow/config", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signConvention: v }) });
    loadStatus();
  }, [loadStatus]);

  // ── panels (all keyed on storeVersion + selectors) ──
  const dep = [version, pair, ck];
  const monitor = usePanel("monitor", {}, [version]);
  const heatmap = usePanel("heatmap", {}, [version]);
  const anomaly = usePanel("anomaly", {}, [version]);
  const typical = usePanel("typicalweek", { pair, clientType: ck }, dep);
  const tape = usePanel("tape", { pair, clientType: ck }, dep);
  const posn = usePanel("positioning", { pair, clientType: ck }, dep);
  const strip = usePanel("positioning", { clientType: ck }, [version, ck]);
  const intraday = usePanel("intraday", { pair, clientType: ck, weeks }, [...dep, weeks]);
  const [exME, setExME] = useState(false);
  const dow = usePanel("dow", { pair, clientType: ck, weeks: 52, exMonthEnd: exME }, [...dep, exME]);
  const tom = usePanel("tom", { pair, clientType: ck }, dep);
  const moy = usePanel("moy", { pair, clientType: ck }, dep);
  const holUs = usePanel("holiday_us", { pair, clientType: ck }, dep);
  const holLoc = usePanel("holiday_local", { pair, clientType: ck }, dep);

  // ── table styles ──
  const th = { padding: "4px 7px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", letterSpacing: ".05em", borderBottom: `2px solid #334155`, whiteSpace: "nowrap", textAlign: "right" };
  const thL = { ...th, textAlign: "left" };
  const td = { padding: "4px 7px", fontSize: 10, fontFamily: C.mono, color: C.text, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}`, textAlign: "right" };
  const tdL = { ...td, textAlign: "left" };
  const wrap = { maxWidth: 1320, margin: "0 auto", padding: "16px 16px 48px" };

  const lastUpload = status?.uploads?.find((u) => u.committed === 1);

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <div style={wrap}>

        {/* ── Header ── */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: ".05em" }}>CLIENT FLOW</span>
          <span style={{ fontSize: 10, color: C.sub }}>weekly client-flow analytics — one desk's book · file time · no proxies</span>
          <span style={{ marginLeft: "auto", fontSize: 9, color: C.dim, fontFamily: C.mono }}>
            {status ? `store v${version} · last upload ${lastUpload?.uploaded_at?.slice(0, 10) ?? "—"}` : "loading…"}
          </span>
          <span style={{ alignSelf: "center" }}><InfoButton docKey="clientflow" /></span>
        </div>

        {/* ── Banners ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {statusErr && <WarnStrip color={C.down}>status unavailable — {statusErr} (is the backend running?)</WarnStrip>}
          {status && !status.gitSafety?.ok && (
            <WarnStrip color={C.down}>⛔ INGEST DISABLED — git safety canary failed: {status.gitSafety?.reason}</WarnStrip>
          )}
          {status && sign === "unconfirmed" && !empty && (
            <WarnStrip>
              sign convention UNCONFIRMED — charts show signed values without direction wording.{" "}
              Positive cumUSD = clients net BUY USD in USDXXX?{" "}
              <button onClick={() => setSign("pos_buys_usd")} style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, fontFamily: C.mono, cursor: "pointer", background: "rgba(74,222,128,0.12)", border: `1px solid ${C.up}55`, color: C.up, borderRadius: 4, padding: "2px 8px" }}>CONFIRM</button>
              <button onClick={() => setSign("pos_sells_usd")} style={{ marginLeft: 4, fontSize: 9, fontWeight: 800, fontFamily: C.mono, cursor: "pointer", background: "rgba(248,113,113,0.12)", border: `1px solid ${C.down}55`, color: C.down, borderRadius: 4, padding: "2px 8px" }}>IT'S THE OPPOSITE</button>
            </WarnStrip>
          )}
        </div>

        {/* ── Upload strip ── */}
        <Panel title="Upload — weekly export (.csv / .tsv; two-phase: preview → commit)" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doPreview(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy || (status && !status.gitSafety?.ok)}
              style={{ fontSize: 10, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer",
                       padding: "8px 18px", background: "rgba(34,211,238,0.12)", border: `1px solid ${C.cyan}66`,
                       color: busy ? C.dim : C.cyan, letterSpacing: ".06em" }}>
              {busy ? "WORKING…" : "CHOOSE FILE"}
            </button>
            <span style={{ fontSize: 9, color: C.dim }}>
              long format: [Pair] · View Type/Type · Time (DD/MM/YYYY HH:MM) · cumUSD — values stored raw, blanks skipped &amp; counted, never zero-filled
            </span>
          </div>
          {uploadErr && <div style={{ marginTop: 8 }}><WarnStrip color={C.down}>{uploadErr}</WarnStrip></div>}
          {preview && (
            <div style={{ marginTop: 10, background: C.panel2, border: `1px solid ${preview.verdict === "clean" ? C.border : C.amber + "66"}`, borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontFamily: C.mono, fontSize: 10.5, fontWeight: 800,
                            color: preview.verdict === "clean" ? C.up2 : preview.verdict === "duplicate" ? C.dim : C.amber }}>
                VERDICT: {preview.verdict.toUpperCase()}
                {preview.verdict === "duplicate" && ` — duplicate of upload #${preview.duplicateOf}, nothing to do`}
              </div>
              {preview.verdict !== "duplicate" && (<>
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.sub, marginTop: 6, lineHeight: 1.7 }}>
                  new {preview.rowsNew} · changed {preview.rowsChanged} · unchanged {preview.rowsUnchanged} · unusable {preview.rowsUnusable} ·
                  blank {preview.blankCells} · masked {preview.hashCells} · col-conflicts {preview.colConflicts} · intra-dup {preview.intraFileConflicts}
                  <br />pairs: {preview.pairsInFile?.join(", ")} · types: {preview.clientTypesInFile?.join(" · ")}
                </div>
                {preview.handCopiedNote && <div style={{ marginTop: 6 }}><WarnStrip>{preview.handCopiedNote}</WarnStrip></div>}
                {preview.rebase?.length > 0 && (
                  <div style={{ marginTop: 6 }}><WarnStrip>
                    REBASE detected — the export re-anchored: {preview.rebase.map((r) => `${r.pair}/${r.clientType} offset ≈ ${fsgn(r.offsetEst)}m @ ${r.ts}`).join("; ")}.
                    On commit the seam is voided (never differenced) and positioning re-anchors with a visible marker.
                  </WarnStrip></div>
                )}
                {preview.restatement?.count > 0 && (
                  <div style={{ marginTop: 6 }}><WarnStrip>
                    RESTATEMENT — {preview.restatement.count} overlapping values changed (max |Δ| {fm(preview.restatement.maxAbs)}m); each is logged and revertable.
                  </WarnStrip></div>
                )}
                {preview.typeRenameWarnings?.length > 0 && (
                  <div style={{ marginTop: 6 }}><WarnStrip>{preview.typeRenameWarnings.join(" · ")} — kept separate, never auto-merged.</WarnStrip></div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button onClick={doCommit} disabled={busy}
                    style={{ fontSize: 10, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer", padding: "6px 16px",
                             background: "rgba(74,222,128,0.12)", border: `1px solid ${C.up}66`, color: C.up }}>COMMIT</button>
                  <button onClick={() => setPreview(null)}
                    style={{ fontSize: 10, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer", padding: "6px 16px",
                             background: "transparent", border: `1px solid ${C.border}`, color: C.sub }}>DISCARD</button>
                </div>
              </>)}
            </div>
          )}
        </Panel>

        {empty && !statusErr && (
          <div style={{ marginTop: 14, fontSize: 11, color: C.dim, fontStyle: "italic" }}>
            no flow data yet — upload the export above to unlock the dashboard (nothing is shown until real data exists)
          </div>
        )}

        {!empty && (<>
          {/* ── Selectors ── */}
          <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ minWidth: 220, flex: "0 1 340px" }}>
              <Seg small value={pair} onChange={setPair} options={pairs.map((p) => [p, p])} />
            </div>
            <div style={{ minWidth: 220, flex: "0 1 420px" }}>
              <Seg small value={ck} onChange={setCk}
                options={ctypes.map((t) => [t.key, t.isAgg ? `${t.label} ⌀` : t.label])} />
            </div>
            <span style={{ fontSize: 8.5, color: C.dim }}>⌀ = aggregate of all segments · flows in USD mio{signSuffix}</span>
          </div>

          {/* ═══ NOW ═══ */}
          {/* B1 anomaly strip */}
          <div style={{ marginTop: 14 }}>
            {anomaly.res?.data?.chips?.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {anomaly.res.data.chips.slice(0, 14).map((c, i) => (
                  <span key={i} style={{ fontFamily: C.mono, fontSize: 9.5, fontWeight: 800, borderRadius: 5, padding: "3px 9px",
                                         background: `${zColor(c.z)}14`, border: `1px solid ${zColor(c.z)}55`, color: zColor(c.z), cursor: "pointer" }}
                        onClick={() => { setPair(c.pair); setCk(c.ctypeKey); }}>
                    {c.pair} · {c.clientType} · {c.horizon} z {fsgn(c.z, 1)}
                  </span>
                ))}
              </div>
            ) : anomaly.res ? (
              <span style={{ fontSize: 9.5, color: C.dim, fontStyle: "italic" }}>nothing unusual this week (|z| ≥ 2 on 1w/4w regime-scaled flow) — that is a result, not a gap</span>
            ) : null}
          </div>

          {/* B2 monitor */}
          <Panel title="Weekly flow monitor — regime-scaled (net / trailing-26w median gross')" style={{ marginTop: 10 }}>
            {monitor.err && <WarnStrip color={C.down}>{monitor.err}</WarnStrip>}
            {monitor.res && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
                  <thead><tr>
                    <th style={thL}>Pair</th><th style={thL}>Segment</th>
                    <th style={th}>1w</th><th style={th}>WoW</th><th style={th}>4w</th><th style={th}>13w</th>
                    <th style={th}>z 1w</th><th style={th}>4w %ile</th><th style={th}>Streak</th><th style={thL}>Mom.</th><th style={th}>n wk</th>
                  </tr></thead>
                  <tbody>
                    {Object.entries(monitor.res.data.rows).flatMap(([p, segs]) =>
                      Object.entries(segs).map(([k, r]) => (
                        <tr key={p + k} style={{ background: p === pair && k === ck ? "rgba(34,211,238,0.06)" : "transparent", cursor: "pointer" }}
                            onClick={() => { setPair(p); setCk(k); }}>
                          <td style={{ ...tdL, fontWeight: 800 }}>{p}</td>
                          <td style={{ ...tdL, color: C.sub }}>{r.label}{r.partial && <span style={{ color: C.amber }} title="current week partial — z suppressed"> ◐</span>}</td>
                          <td style={{ ...td, color: zColor(r.net1w) }}>{fsgn(r.net1w)}</td>
                          <td style={td}>{fsgn(r.wow)}</td>
                          <td style={{ ...td, color: zColor(r.net4w) }}>{fsgn(r.net4w)}</td>
                          <td style={td}>{fsgn(r.net13w)}</td>
                          <td style={{ ...td, color: zColor(r.z1w), fontWeight: 800 }}>{r.z1w != null ? fsgn(r.z1w, 2) : "—"}</td>
                          <td style={td}>{r.pct4w != null ? r.pct4w : "—"}</td>
                          <td style={td} title={r.streak?.pctile != null ? `longer than ${r.streak.pctile}% of ${r.streak.nStreaks} completed streaks` : `${r.streak?.nStreaks ?? 0} completed streaks (<20: raw count only, hist max ${r.streak?.histMax ?? "—"})`}>
                            {r.streak?.len ? `${r.streak.sign > 0 ? "▲" : "▼"}${r.streak.len}` : "—"}
                          </td>
                          <td style={{ ...tdL, fontSize: 8.5, color: C.dim }}>{r.momentum}</td>
                          <td style={{ ...td, color: C.dim }}>{r.nWeeks}</td>
                        </tr>
                      )))}
                  </tbody>
                </table>
              </div>
            )}
            <MetaFooter meta={monitor.res?.meta} />
          </Panel>

          {/* B4 heatmap */}
          <Panel title="Flow heatmap — robust z (median/MAD vs trailing 2y) · 1w/4w/13w overlap: one story, not three confirmations" style={{ marginTop: 12 }}>
            {heatmap.res && (() => {
              const cells = heatmap.res.data.cells;
              const keys = [...new Set(cells.map((c) => `${c.pair}|${c.ctypeKey}`))];
              return (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", minWidth: 480 }}>
                    <thead><tr><th style={thL}>Series</th>{["1w", "4w", "13w"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {keys.map((key) => {
                        const [p, k] = key.split("|");
                        const row = cells.filter((c) => c.pair === p && c.ctypeKey === k);
                        return (
                          <tr key={key} style={{ cursor: "pointer" }} onClick={() => { setPair(p); setCk(k); }}>
                            <td style={tdL}>{p} · <span style={{ color: C.sub }}>{row[0]?.clientType}</span></td>
                            {["1w", "4w", "13w"].map((h) => {
                              const c = row.find((x) => x.horizon === h);
                              const z = c?.z;
                              const bg = z == null ? "transparent" : `rgba(${z > 0 ? "74,222,128" : "248,113,113"},${Math.min(0.5, Math.abs(z) / 5)})`;
                              return (
                                <td key={h} style={{ ...td, background: bg }} title={c?.reason || `raw ${fsgn(c?.raw)}m · n=${c?.nWeeks}w`}>
                                  {z != null ? fsgn(z, 1) : <span style={{ color: C.dim }}>·</span>}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
            <MetaFooter meta={heatmap.res?.meta} />
          </Panel>

          {/* B3 typical week */}
          <Panel title={`This week vs typical — ${pair} · cumulative net, re-anchored at the Friday-23:59 week boundary`} style={{ marginTop: 12 }}>
            {typical.res?.data ? (<>
              <Plot
                data={[
                  { x: typical.res.data.envelope.pos, y: typical.res.data.envelope.p90, line: { width: 0 }, hoverinfo: "skip", showlegend: false },
                  { x: typical.res.data.envelope.pos, y: typical.res.data.envelope.p10, fill: "tonexty", fillcolor: "rgba(148,163,184,0.08)", line: { width: 0 }, name: "10–90%", hoverinfo: "skip" },
                  { x: typical.res.data.envelope.pos, y: typical.res.data.envelope.p75, line: { width: 0 }, hoverinfo: "skip", showlegend: false },
                  { x: typical.res.data.envelope.pos, y: typical.res.data.envelope.p25, fill: "tonexty", fillcolor: "rgba(148,163,184,0.14)", line: { width: 0 }, name: "25–75%", hoverinfo: "skip" },
                  { x: typical.res.data.envelope.pos, y: typical.res.data.envelope.median, name: "median week", line: { color: C.dim, width: 1.2, dash: "dot" } },
                  { x: typical.res.data.current.pos, y: typical.res.data.current.cum, name: "this week", line: { color: C.cyan, width: 2 } },
                ]}
                layout={{ ...plotBase, height: 220, xaxis: { ...plotBase.xaxis, title: { text: "hours into week (file time, Sat 00:00 origin)", font: { size: 8 } } } }}
                config={plotCfg} style={{ width: "100%" }} useResizeHandler
              />
              <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono }}>
                envelope: {typical.res.data.nEnvelopeWeeks} weeks · largest prints this week: {typical.res.data.largestPrints.map((p) => fsgn(p.flow)).join(", ") || "—"}
              </div>
            </>) : typical.res ? <span style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>insufficient usable buckets for this series</span> : null}
            <MetaFooter meta={typical.res?.meta} />
          </Panel>

          {/* ═══ TAPE ═══ */}
          <Panel title={`Flow tape — ${pair} · ${ctypes.find((t) => t.key === ck)?.label ?? ck} · cumulative rebased (positioning proxy, relative only) + daily net`} style={{ marginTop: 12 }}>
            {tape.res?.data ? (() => {
              const d = tape.res.data;
              const spotTrace = d.spot?.available ? [{
                x: d.spot.dates, y: d.spot.mid, name: "spot (daily mid)", yaxis: "y2",
                line: { color: C.violet, width: 1 }, opacity: 0.7,
              }] : [];
              return (<>
                {!d.spot?.available && (
                  <div style={{ marginBottom: 8 }}><WarnStrip>spot overlay unavailable — {d.spot?.reason}</WarnStrip></div>
                )}
                <Plot
                  data={[
                    { x: d.cum.ts, y: d.cum.value, name: `cum flow since ${d.anchor?.slice(0, 10)}`, line: { color: C.cyan, width: 1.6 }, fill: "tozeroy", fillcolor: "rgba(34,211,238,0.05)" },
                    ...spotTrace,
                  ]}
                  layout={{ ...plotBase, height: 260,
                    yaxis: { ...plotBase.yaxis, title: { text: `USD mio${signSuffix}`, font: { size: 8 } } },
                    yaxis2: { overlaying: "y", side: "right", gridcolor: "transparent", tickfont: { size: 8, color: C.violet } },
                    shapes: (d.cum.breaks || []).map((b) => ({ type: "line", x0: b.ts, x1: b.ts, yref: "paper", y0: 0, y1: 1, line: { color: C.amber, width: 1, dash: "dot" } })),
                    legend: { orientation: "h", font: { size: 8 } } }}
                  config={plotCfg} style={{ width: "100%" }} useResizeHandler
                />
                <Plot
                  data={[{
                    x: d.daily.map((r) => r.date), y: d.daily.map((r) => r.f), type: "bar",
                    marker: { color: d.daily.map((r) => r.state === "gapSpanned" ? C.amber : (r.f >= 0 ? C.up2 : C.down)),
                              opacity: d.daily.map((r) => r.partialClose ? 0.45 : 0.9) },
                    customdata: d.daily.map((r) => [r.spanDays, r.nBuckets, r.state]),
                    hovertemplate: "%{x}<br>%{y:.1f}m · span %{customdata[0]}d · %{customdata[1]} buckets · %{customdata[2]}<extra></extra>",
                    name: "daily net",
                  }]}
                  layout={{ ...plotBase, height: 130, margin: { ...plotBase.margin, t: 2 } }}
                  config={plotCfg} style={{ width: "100%" }} useResizeHandler
                />
                <div style={{ fontSize: 8.5, color: C.dim }}>
                  amber bars span a data gap (drawn once over their true range, never spread) · hollow = partial close · {d.satAlarms > 0 && <span style={{ color: C.amber }}>⚠ {d.satAlarms} Saturday-flow alarms (data quality, not data) · </span>}
                  level breaks dotted amber
                </div>
              </>);
            })() : tape.res ? <span style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>no data for this series</span> : null}
            <MetaFooter meta={tape.res?.meta} />
          </Panel>

          {/* C2 positioning */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <Panel title={`Positioning gauge — ${pair} weekly closes (proxy since data start; one desk's book, never market positioning)`}>
              {posn.res?.data && posn.res.data.weeks ? (() => {
                const d = posn.res.data;
                return (<>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    {["26w", "52w", "104w"].map((w) => (
                      <div key={w} style={{ flex: 1, background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px" }}>
                        <div style={{ fontSize: 8, color: C.dim, fontWeight: 700 }}>{w} RANGE POS</div>
                        <div style={{ fontFamily: C.mono, fontSize: 15, fontWeight: 800, color: d.R[w] == null ? C.dim : d.R[w] > 80 || d.R[w] < 20 ? C.amber : C.text }}>
                          {d.R[w] != null ? `${d.R[w]}%` : "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                  <Plot
                    data={[
                      ...(d.band52 ? [
                        { x: d.weeks.slice(-52), y: Array(Math.min(52, d.weeks.length)).fill(d.band52.max), line: { width: 0 }, hoverinfo: "skip", showlegend: false },
                        { x: d.weeks.slice(-52), y: Array(Math.min(52, d.weeks.length)).fill(d.band52.min), fill: "tonexty", fillcolor: "rgba(148,163,184,0.07)", line: { width: 0 }, name: "1y min-max", hoverinfo: "skip" },
                      ] : []),
                      { x: d.weeks, y: d.level, name: "weekly close level", line: { color: C.cyan, width: 1.5 } },
                    ]}
                    layout={{ ...plotBase, height: 180, showlegend: false }}
                    config={plotCfg} style={{ width: "100%" }} useResizeHandler
                  />
                </>);
              })() : <span style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>needs ≥26 weeks of closes</span>}
              <MetaFooter meta={posn.res?.meta} />
            </Panel>
            <Panel title="Cross-pair positioning — 52w range position, sorted by extremity">
              {strip.res?.data?.strip ? (
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead><tr><th style={thL}>Pair</th><th style={th}>R 52w</th><th style={thL}>52w level</th><th style={th}>n wk</th></tr></thead>
                  <tbody>
                    {strip.res.data.strip.map((r) => (
                      <tr key={r.pair} style={{ cursor: "pointer" }} onClick={() => setPair(r.pair)}>
                        <td style={{ ...tdL, fontWeight: 800 }}>{r.pair}</td>
                        <td style={{ ...td, color: r.R52 == null ? C.dim : r.R52 > 80 || r.R52 < 20 ? C.amber : C.text }}>{r.R52 != null ? `${r.R52}%` : "—"}</td>
                        <td style={{ ...tdL, width: 120 }}>
                          {r.spark52?.length > 5 && (
                            <Plot data={[{ y: r.spark52, line: { color: C.dim, width: 1 } }]}
                              layout={{ paper_bgcolor: "transparent", plot_bgcolor: "transparent", height: 22, width: 110,
                                        margin: { l: 0, r: 0, t: 0, b: 0 }, xaxis: { visible: false }, yaxis: { visible: false } }}
                              config={{ ...plotCfg, staticPlot: true }} />
                          )}
                        </td>
                        <td style={{ ...td, color: C.dim }}>{r.nWeeks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <MetaFooter meta={strip.res?.meta} />
            </Panel>
          </div>

          {/* ═══ SEASONALITY ═══ */}
          <Panel title={`Intraday profile — ${pair} · per-bucket net flow (file time; no session labels until mapping confirmed)`} style={{ marginTop: 12 }}
                 right={<div style={{ width: 200 }}><Seg small value={weeks} onChange={setWeeks} options={[[26, "26w"], [52, "52w"], [520, "all"]]} /></div>}>
            {intraday.res?.data ? (() => {
              const cells = intraday.res.data.cells.filter((c) => c.n > 0 || c.mean != null);
              return (<>
                <Plot
                  data={[
                    { x: cells.map((c) => c.bucket), y: cells.map((c) => c.meanAbs), type: "bar", name: "mean |flow| (activity)",
                      marker: { color: "rgba(148,163,184,0.25)" } },
                    { x: cells.map((c) => c.bucket), y: cells.map((c) => c.mean), type: "bar", name: "mean net",
                      marker: { color: cells.map((c) => c.bucket === "OVERNIGHT" ? C.amber : zColor(c.mean)) },
                      error_y: { type: "data", symmetric: false,
                                 array: cells.map((c) => c.ci ? c.ci[1] - c.mean : null),
                                 arrayminus: cells.map((c) => c.ci ? c.mean - c.ci[0] : null),
                                 color: C.sub, thickness: 1 } },
                  ]}
                  layout={{ ...plotBase, height: 220, barmode: "overlay", legend: { orientation: "h", font: { size: 8 } } }}
                  config={plotCfg} style={{ width: "100%" }} useResizeHandler
                />
                <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono }}>
                  n/cell: {cells.map((c) => `${c.bucket} ${c.n}`).join(" · ")} · cells blank below n=60 · CI = day-level block bootstrap
                  {intraday.res.data.kruskalP != null && ` · Kruskal-Wallis any-pattern p=${intraday.res.data.kruskalP.toFixed(3)}`}
                  {intraday.res.data.benchmarkCandidate && ` · candidate benchmark window: ${intraday.res.data.benchmarkCandidate} (candidate only)`}
                  {intraday.res.data.sunOpen?.mean != null && ` · SUN OPEN mean ${fsgn(intraday.res.data.sunOpen.mean)} (n=${intraday.res.data.sunOpen.n})`}
                </div>
              </>);
            })() : null}
            <MetaFooter meta={intraday.res?.meta} />
          </Panel>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            {/* D2 day-of-week */}
            <Panel title="Day-of-week profile — daily net, trailing 52w"
                   right={<button onClick={() => setExME(!exME)} style={{ fontSize: 8.5, fontWeight: 800, fontFamily: C.mono, borderRadius: 4, cursor: "pointer", padding: "3px 8px",
                                 background: exME ? "rgba(34,211,238,0.14)" : "transparent", border: `1px solid ${exME ? C.cyan : C.border}`, color: exME ? C.cyan : C.dim }}>
                     ex month-end</button>}>
              {dow.res?.data ? (() => {
                const days = dow.res.data.days;
                return (<>
                  <Plot
                    data={[{
                      x: days.map((d) => d.day), y: days.map((d) => d.mean), type: "bar",
                      marker: { color: days.map((d) => d.significant ? (d.mean > 0 ? C.up : C.down) : "rgba(148,163,184,0.35)") },
                      error_y: { type: "data", symmetric: false,
                                 array: days.map((d) => d.ci ? d.ci[1] - d.mean : null),
                                 arrayminus: days.map((d) => d.ci ? d.mean - d.ci[0] : null), color: C.sub, thickness: 1 },
                    }]}
                    layout={{ ...plotBase, height: 180 }}
                    config={plotCfg} style={{ width: "100%" }} useResizeHandler
                  />
                  <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, lineHeight: 1.7 }}>
                    {days.map((d) => `${d.day} n=${d.n}${d.hitRate != null ? ` hit ${(100 * d.hitRate).toFixed(0)}%` : ""}${d.significant ? " *q≤.10" : ""}${d.unstable ? " ⚠unstable" : ""}`).join(" · ")}
                    {dow.res.data.sunOpen?.mean != null && ` · SUN OPEN ${fsgn(dow.res.data.sunOpen.mean)} (n=${dow.res.data.sunOpen.n})`}
                    <br />solid bars = BH-FDR q≤0.10 within this pair (grid-wide flags live in the heatmap) · holidays routed to the event studies below
                  </div>
                </>);
              })() : null}
              <MetaFooter meta={dow.res?.meta} />
            </Panel>

            {/* D3 turn-of-month */}
            <Panel title="Turn-of-month — business-day offsets on the union US+local calendar">
              {tom.res?.data ? (() => {
                const offs = tom.res.data.offsets;
                return (<>
                  <Plot
                    data={[{
                      x: offs.map((o) => o.offset), y: offs.map((o) => o.mean), type: "bar",
                      marker: { color: offs.map((o) => o.offset === "-1" ? C.amber : zColor(o.mean)) },
                      error_y: { type: "data", symmetric: false,
                                 array: offs.map((o) => o.ci && o.mean != null ? o.ci[1] - o.mean : null),
                                 arrayminus: offs.map((o) => o.ci && o.mean != null ? o.mean - o.ci[0] : null), color: C.sub, thickness: 1 },
                    }]}
                    layout={{ ...plotBase, height: 180, xaxis: { ...plotBase.xaxis, type: "category" } }}
                    config={plotCfg} style={{ width: "100%" }} useResizeHandler
                  />
                  <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono, lineHeight: 1.7 }}>
                    N = {tom.res.data.nMonths} months · CI = month-level bootstrap · medians &amp; hit-rates in tooltip (means are lumpy — a few months dominate)
                    {tom.res.data.welchPreVsMid && ` · BD−1/−2 vs mid: p=${tom.res.data.welchPreVsMid.p.toFixed(3)}`}
                  </div>
                </>);
              })() : null}
              <MetaFooter meta={tom.res?.meta} />
            </Panel>
          </div>

          {/* D4 month-of-year */}
          <Panel title="Month-of-year — one dot per YEAR (no CI theatre at N≈3 years); medians as ticks" style={{ marginTop: 12 }}>
            {moy.res?.data ? (() => {
              const months = moy.res.data.months;
              const pts = months.flatMap((m) => m.years.map((y) => ({ m: m.month, ...y })));
              return (<>
                <Plot
                  data={[
                    { x: pts.map((p) => p.m), y: pts.map((p) => p.net), mode: "markers", type: "scatter",
                      text: pts.map((p) => String(p.year)), name: "year net",
                      marker: { size: 7, color: pts.map((p) => zColor(p.net)), opacity: 0.75 },
                      hovertemplate: "M%{x} %{text}: %{y:.0f}m<extra></extra>" },
                    { x: months.filter((m) => m.median != null).map((m) => m.month),
                      y: months.filter((m) => m.median != null).map((m) => m.median),
                      mode: "markers", name: "median", marker: { symbol: "line-ew-open", size: 16, color: C.cyan, line: { width: 2 } } },
                  ]}
                  layout={{ ...plotBase, height: 210, xaxis: { ...plotBase.xaxis, tickvals: [1,2,3,4,5,6,7,8,9,10,11,12], ticktext: ["J","F","M","A","M","J","J","A","S","O","N","D"] }, legend: { orientation: "h", font: { size: 8 } } }}
                  config={plotCfg} style={{ width: "100%" }} useResizeHandler
                />
                <div style={{ fontSize: 8.5, color: C.dim, fontFamily: C.mono }}>
                  {moy.res.data.kruskalP != null
                    ? `Kruskal-Wallis seasonality p=${moy.res.data.kruskalP.toFixed(3)} (unlocked at ≥8 years)`
                    : `N=${moy.res.data.nYears} of 8 years — seasonality test locked (dots are the honest view)`}
                </div>
              </>);
            })() : null}
            <MetaFooter meta={moy.res?.meta} />
          </Panel>

          {/* ═══ HOLIDAYS ═══ */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            {[["US holidays", holUs], ["Local holidays", holLoc]].map(([title, st]) => (
              <Panel key={title} title={`${title} — event study vs weekday-matched baseline (BD offsets, union calendar)`}>
                {st.res?.data ? (() => {
                  const d = st.res.data;
                  return (<>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}>
                      <thead><tr><th style={thL}>Offset</th><th style={th}>Δ vs base (m)</th><th style={th}>Δ (sd)</th><th style={th}>95% CI</th><th style={th}>p</th><th style={th}>q</th><th style={th}>n ev</th></tr></thead>
                      <tbody>
                        {d.grid.map((c, i) => (
                          <tr key={i}>
                            <td style={{ ...tdL, fontWeight: 800, color: c.offset < 0 ? C.cyan : C.sub }}>{c.offset > 0 ? `T+${c.offset}` : `T${c.offset}`}</td>
                            <td style={{ ...td, color: zColor(c.deltaUsdM), fontWeight: c.q != null && c.q <= 0.1 ? 800 : 400 }}>{fsgn(c.deltaUsdM)}</td>
                            <td style={td}>{fsgn(c.deltaSd, 2)}</td>
                            <td style={{ ...td, color: C.dim, fontSize: 8.5 }}>{c.ci ? `[${fm(c.ci[0])}, ${fm(c.ci[1])}]` : "—"}</td>
                            <td style={td}>{c.welchP != null ? c.welchP.toFixed(3) : "—"}</td>
                            <td style={{ ...td, color: c.q != null && c.q <= 0.1 ? C.up2 : C.dim }}>{c.q != null ? c.q.toFixed(2) : "—"}</td>
                            <td style={{ ...td, color: c.nEvents < 10 ? C.amber : C.dim }}>{c.nEvents}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: 8.5, color: C.dim, marginTop: 6, lineHeight: 1.6 }}>
                      {d.nEvents} events{d.nOverlap > 0 && ` (+${d.nOverlap} US∩local overlap kept separate)`} · cells blank below n=10 ·
                      next: {d.upcoming.slice(0, 2).map((u) => `${u.name} in ${u.bizDaysAway}bd`).join(" · ") || "—"}
                    </div>
                  </>);
                })() : st.res ? (
                  <span style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>
                    {(st.res.meta?.flags || []).map((f) => f.detail).join(" · ") || "insufficient data"}
                  </span>
                ) : null}
                <MetaFooter meta={st.res?.meta} />
              </Panel>
            ))}
          </div>

          {/* ═══ DATA ═══ */}
          <Panel title="Data integrity — uploads, coverage, aggregation identity, level breaks" style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: C.dim, marginBottom: 6 }}>UPLOAD LOG</div>
                <div style={{ overflowX: "auto", maxHeight: 220, overflowY: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead><tr><th style={thL}>#</th><th style={thL}>File</th><th style={thL}>When</th><th style={th}>+ / Δ</th><th style={th}>QC</th><th style={th}></th></tr></thead>
                    <tbody>
                      {(status?.uploads || []).map((u) => (
                        <tr key={u.id} style={{ opacity: u.committed === 1 ? 1 : 0.45 }}>
                          <td style={tdL}>{u.id}</td>
                          <td style={{ ...tdL, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{u.filename}{u.committed === -1 && " (reverted)"}</td>
                          <td style={{ ...tdL, color: C.dim }}>{u.uploaded_at?.slice(0, 10)}</td>
                          <td style={td}>{u.rows_added} / {u.rows_updated}</td>
                          <td style={{ ...td, color: (u.hash_cells || u.col_conflicts || u.rebase_detected) ? C.amber : C.dim, fontSize: 8.5 }}
                              title={`blank ${u.blank_cells} · masked ${u.hash_cells} · col-conflict ${u.col_conflicts} · restated ${u.restatement_count}${u.rebase_detected ? " · REBASE" : ""}`}>
                            {u.rebase_detected ? "REBASE" : (u.restatement_count ? `Δ${u.restatement_count}` : "clean")}
                          </td>
                          <td style={td}>
                            {u.committed === 1 && (
                              <button onClick={() => doRevert(u.id)} style={{ fontSize: 8, fontWeight: 800, background: "none", border: `1px solid ${C.border}`, color: C.dim, borderRadius: 4, cursor: "pointer", padding: "1px 6px" }}>revert</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 9, fontWeight: 800, color: C.dim, marginBottom: 6 }}>COVERAGE · IDENTITY · BREAKS</div>
                <div style={{ fontSize: 9.5, fontFamily: C.mono, color: C.sub, lineHeight: 1.8 }}>
                  {Object.entries(status?.coverage || {}).map(([p, cts]) => (
                    <div key={p}>
                      <b style={{ color: C.text }}>{p}</b>: {Object.entries(cts).map(([k, v]) =>
                        `${v.label} ${v.from?.slice(0, 10)}→${v.to?.slice(0, 10)} (${v.nObs})`).join(" · ")}
                    </div>
                  ))}
                  {Object.entries(status?.aggResidual || {}).map(([p, r]) => (
                    <div key={p} style={{ color: r.pctFlagged > 5 ? C.amber : C.dim }}>
                      {p} aggregation identity: median |ρ| {fm(r.medianAbs, 2)}m · {r.pctFlagged}% of {r.nDays} days flagged
                      {r.pctFlagged > 5 && " — persistent residual: hidden/renamed segment or export definition issue"}
                    </div>
                  ))}
                  {(status?.levelBreaks || []).map((b, i) => (
                    <div key={i} style={{ color: C.amber }}>break: {b.pair} · {b.ctype_key} @ {b.ts} ({b.kind}, offset ≈ {fsgn(b.offset_est)}m)</div>
                  ))}
                </div>
              </div>
            </div>
          </Panel>

          <div style={{ fontSize: 8.5, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
            All flows in USD mio from the uploaded export (values stored raw{signSuffix}). Cumulative levels are RELATIVE — the export's anchor is unknown.
            Statistics admit only clean single-bucket observations; gap-spanning diffs are shown once over their true range and excluded from profiles (counted in each panel's footer).
            gross' = Σ|3h net flows| — a lower bound on gross (intra-bucket two-way business nets out); never read it as volume.
            No polling — refetches on upload commit only.
          </div>
        </>)}
      </div>
    </div>
  );
}
