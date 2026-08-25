// Carry Basket — a vol-adjusted long/short carry sizing monitor.
//
// Idea (trader spec): go LONG the highest-yielding currencies and SHORT the lowest,
// across all traded EM currencies (the pricer universe) PLUS the G10 (not in the
// pricer). A yield RANK across the combined universe is always shown. The user picks
// the longs (top-N or specific) with USD notionals and the shorts (count or specific);
// the tool sizes the short leg VOL-ADJUSTED to balance the longs and reports the book
// risk (from the full covariance) + carry efficiency.
//
// Data is ON PAR with the pricer: same spot/points/NDF feeds, same DF yield engine,
// and the same holiday-adjusted 1M day count (verified to 0.0 bp vs the pricer's iyDf).
//
//   GET  /api/carry/rank                → 1M fwd-implied yield rank (EM + G10)
//   POST /api/carry/basket {longs,shorts,sizingMode,weighting,window} → sized book
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import Plot from "react-plotly.js";
import { F, FP } from "../calc.js";
import { InfoButton } from "./InfoDoc.jsx";

// ── Dark theme (mirrors NeerApp / RiskUnits / the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

const num = (v, dp = 2) => F(v, dp);
const sgn = (v, dp = 2) => FP(v, dp);
const usd = (v, dp = 0) => (v == null || !isFinite(v))
  ? "—"
  : "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usdM = (v) => (v == null || !isFinite(v)) ? "—"
  : (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}mm` : usd(v));

const WINDOWS = [10, 20, 60, 90];
const Z95 = 1.645, Z99 = 2.326;

// ── Building blocks ──
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
          <button key={id} onClick={() => onChange(id)} style={{
            flex: 1, fontSize: small ? 9.5 : 10, fontWeight: 800, fontFamily: C.mono,
            padding: small ? "5px 0" : "6px 0", borderRadius: 5, cursor: "pointer",
            background: on ? "rgba(34,211,238,0.14)" : C.panel2,
            border: `1px solid ${on ? C.cyan : C.border}`, color: on ? C.cyan : C.sub,
            whiteSpace: "nowrap",
          }}>{lbl}</button>
        );
      })}
    </div>
  );
}

const inputStyle = {
  background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 5,
  padding: "5px 7px", fontSize: 11, fontFamily: C.mono, width: "100%", outline: "none", boxSizing: "border-box",
};
const miniLabel = { fontSize: 8.5, fontWeight: 700, color: C.dim, letterSpacing: ".06em", textTransform: "uppercase", marginBottom: 4 };

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px" }}>
      <div style={miniLabel}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 16, fontWeight: 800, color: color || C.text, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 8.5, color: C.dim, marginTop: 2, fontFamily: C.mono }}>{sub}</div>}
    </div>
  );
}

const DEFAULT_NOTIONAL = 10000000;

export default function CarryBasket() {
  const [rank, setRank] = useState(null);
  const [rankErr, setRankErr] = useState(null);

  // Selections: longs is an ordered array of {code, notionalUsd}; shorts is [code]
  const [longs, setLongs] = useState([]);
  const [shorts, setShorts] = useState([]);
  const [sizingMode, setSizingMode] = useState("vol_neutral");
  const [weighting, setWeighting] = useState("inverse_vol");
  const [window, setWindow] = useState(20);
  const [legNotional, setLegNotional] = useState(String(DEFAULT_NOTIONAL));
  const [topN, setTopN] = useState(3);
  const [botN, setBotN] = useState(3);

  const [book, setBook] = useState(null);
  const [bookErr, setBookErr] = useState(null);
  const [bookLoading, setBookLoading] = useState(false);

  // β vs equal-weight EM basket (window = the vol lookback) — rank-table column
  const [betas, setBetas] = useState(null);
  // 20y basket history (on demand — heavy pull, cached 24h server-side)
  const [hist, setHist] = useState(null);
  const [histErr, setHistErr] = useState(null);
  const [histLoading, setHistLoading] = useState(false);

  // ── Yield rank (poll 120s, visible tab only; yields move slowly) ──
  useEffect(() => {
    let alive = true;
    const load = async (force) => {
      try {
        const r = await fetch(`/api/carry/rank${force ? "?force=true" : ""}`);
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) { setRankErr((j && (j.detail || j.error)) || `HTTP ${r.status}`); return; }
        setRank(j); setRankErr(null);
      } catch (e) { if (alive) setRankErr(e?.message || "network error"); }
    };
    load(true);
    // Poll only when the tab is visible — a backgrounded dashboard must not keep
    // hitting the rate-limited LSEG session (the daily 10k-request cap). Yields move
    // slowly, so 120s is plenty; refresh immediately when the tab regains focus.
    const id = setInterval(() => { if (!document.hidden) load(false); }, 120000);
    const onVis = () => { if (!document.hidden) load(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // β per window; refetch when the vol lookback changes (server caches 1h per window)
  useEffect(() => {
    let alive = true;
    fetch(`/api/carry/betas?window=${window}`)
      .then(async (r) => { const j = await r.json().catch(() => null); if (alive && r.ok) setBetas(j); })
      .catch(() => {});
    return () => { alive = false; };
  }, [window]);

  // the 20y chart describes ONE specific book — clear it when the book changes
  useEffect(() => { setHist(null); setHistErr(null); }, [longs, shorts, sizingMode, weighting]);

  const loadHist = useCallback(() => {
    if (!longs.length || !shorts.length) return;
    setHistLoading(true); setHistErr(null);
    fetch("/api/carry/basket_history", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longs, shorts, sizingMode, weighting, window, years: 20 }),
    })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok || (j && j.error)) { setHist(null); setHistErr((j && (j.detail || j.error)) || `HTTP ${r.status}`); }
        else { setHist(j); setHistErr(null); }
      })
      .catch((e) => { setHist(null); setHistErr(e?.message || "network error"); })
      .finally(() => setHistLoading(false));
  }, [longs, shorts, sizingMode, weighting, window]);

  const ranked = rank?.rank || [];
  const byCode = useMemo(() => Object.fromEntries(ranked.map(r => [r.code, r])), [ranked]);
  const longSet = useMemo(() => new Set(longs.map(l => l.code)), [longs]);
  const shortSet = useMemo(() => new Set(shorts), [shorts]);

  // ── selection helpers ──
  const notlNum = Math.max(0, Number(legNotional) || 0);
  const addLong = (code) => setLongs(ls => ls.some(l => l.code === code) ? ls : [...ls, { code, notionalUsd: notlNum || DEFAULT_NOTIONAL }]);
  const removeLong = (code) => setLongs(ls => ls.filter(l => l.code !== code));
  const addShort = (code) => setShorts(ss => ss.includes(code) ? ss : [...ss, code]);
  const removeShort = (code) => setShorts(ss => ss.filter(c => c !== code));
  const toggleLong = (code) => (longSet.has(code) ? removeLong(code) : (removeShort(code), addLong(code)));
  const toggleShort = (code) => (shortSet.has(code) ? removeShort(code) : (removeLong(code), addShort(code)));
  const setLegAmt = (code, v) => setLongs(ls => ls.map(l => l.code === code ? { ...l, notionalUsd: Math.max(0, Number(v) || 0) } : l));

  const fillTopLongs = () => {
    const withData = ranked.filter(r => r.hasData);
    const pick = withData.slice(0, Math.max(0, topN | 0));
    setLongs(pick.map(r => ({ code: r.code, notionalUsd: notlNum || DEFAULT_NOTIONAL })));
    setShorts(ss => ss.filter(c => !pick.some(p => p.code === c)));
  };
  const fillBotShorts = () => {
    const withData = ranked.filter(r => r.hasData);
    const pick = withData.slice(Math.max(0, withData.length - Math.max(0, botN | 0)));
    const picks = pick.map(r => r.code).filter(c => !longSet.has(c));
    setShorts(picks);
  };

  // ── size the basket (debounced; backend caches history so re-sizing is cheap) ──
  const debRef = useRef(null);
  const runBasket = useCallback(() => {
    if (!longs.length || !shorts.length) { setBook(null); setBookErr(null); return; }
    setBookLoading(true);
    fetch("/api/carry/basket", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ longs, shorts, sizingMode, weighting, window }),
    })
      .then(async r => {
        const j = await r.json().catch(() => null);
        if (!r.ok) { setBook(null); setBookErr((j && (j.detail || j.error)) || `HTTP ${r.status}`); }
        else if (j && j.error) { setBook(null); setBookErr(j.error); }
        else { setBook(j); setBookErr(null); }
      })
      .catch(e => { setBook(null); setBookErr(e?.message || "network error"); })
      .finally(() => setBookLoading(false));
  }, [longs, shorts, sizingMode, weighting, window]);

  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(runBasket, 400);
    return () => debRef.current && clearTimeout(debRef.current);
  }, [runBasket]);

  // ── styles ──
  const wrap = { maxWidth: 1320, margin: "0 auto", padding: "16px 16px 48px" };
  const th = { padding: "5px 7px", fontSize: 8, fontWeight: 800, color: C.dim, textTransform: "uppercase", letterSpacing: ".05em", borderBottom: `2px solid #334155`, whiteSpace: "nowrap", textAlign: "right" };
  const thL = { ...th, textAlign: "left" };
  const td = { padding: "5px 7px", fontSize: 10.5, fontFamily: C.mono, color: C.text, whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}`, textAlign: "right" };
  const tdL = { ...td, textAlign: "left" };

  const carryColor = (v) => v == null ? C.dim : v > 0 ? C.up2 : C.down;

  // combined legs for the results table (longs then shorts)
  const legs = book ? [...(book.longs || []), ...(book.shorts || [])] : [];
  const var95Book = book?.bookDailyVolUsd != null ? Z95 * book.bookDailyVolUsd : null;
  const var99Book = book?.bookDailyVolUsd != null ? Z99 * book.bookDailyVolUsd : null;

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <div style={wrap}>

        {/* ── Header ── */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: ".05em", color: C.text }}>CARRY BASKET</span>
          <span style={{ fontSize: 10, color: C.sub }}>long high-yield · short low-yield · vol-adjusted sizing — EM (pricer) + G10</span>
          <span style={{ marginLeft: "auto", fontSize: 9, color: C.dim, fontFamily: C.mono }}>
            {rank ? `as of ${rank.asOf} · SOFR1M ${num(rank.sofr1m, 2)}% · ${rank.nWithData}/${rank.nTotal} priced` : "loading…"}
          </span>
          <span style={{ alignSelf: "center" }}><InfoButton docKey="carry" /></span>
        </div>

        {rankErr && (
          <div style={{ marginTop: 12, padding: "8px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
            rank unavailable — {rankErr} (LSEG session/rate-limit — retry shortly)
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 340px) 1fr", gap: 14, marginTop: 14, alignItems: "start" }}>

          {/* ── Controls ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Panel title="Basket construction">
              <div style={{ marginBottom: 10 }}>
                <div style={miniLabel}>Notional per long leg (USD)</div>
                <input style={inputStyle} type="number" min="0" step="1000000" value={legNotional}
                  onChange={e => setLegNotional(e.target.value)} />
                <div style={{ fontSize: 8, color: C.dim, marginTop: 3 }}>default for new longs · edit any leg individually below</div>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={miniLabel}>Long top-N</div>
                  <div style={{ display: "flex", gap: 5 }}>
                    <input style={{ ...inputStyle, width: 52, flex: "0 0 auto" }} type="number" min="1" max="20" value={topN}
                      onChange={e => setTopN(Math.max(1, Number(e.target.value) || 1))} />
                    <button onClick={fillTopLongs} style={{ flex: 1, fontSize: 10, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer", background: "rgba(74,222,128,0.12)", border: `1px solid ${C.up}55`, color: C.up }}>fill</button>
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={miniLabel}>Short bottom-N</div>
                  <div style={{ display: "flex", gap: 5 }}>
                    <input style={{ ...inputStyle, width: 52, flex: "0 0 auto" }} type="number" min="1" max="20" value={botN}
                      onChange={e => setBotN(Math.max(1, Number(e.target.value) || 1))} />
                    <button onClick={fillBotShorts} style={{ flex: 1, fontSize: 10, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer", background: "rgba(248,113,113,0.12)", border: `1px solid ${C.down}55`, color: C.down }}>fill</button>
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={miniLabel}>Short sizing</div>
                <Seg value={sizingMode} onChange={setSizingMode}
                  options={[["vol_neutral", "Vol-neutral"], ["dollar_neutral", "$-neutral"]]} />
                <div style={{ fontSize: 8, color: C.dim, marginTop: 3 }}>
                  {sizingMode === "vol_neutral" ? "short leg $-vol = long leg $-vol (balances risk)" : "short notional = long notional (index convention)"}
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={miniLabel}>Within-leg weighting</div>
                <Seg value={weighting} onChange={setWeighting}
                  options={[["inverse_vol", "Inverse-vol"], ["equal_notional", "Equal-notl"]]} />
              </div>

              <div>
                <div style={miniLabel}>Vol lookback</div>
                <Seg small value={window} onChange={setWindow} options={WINDOWS.map(w => [w, `${w}d`])} />
                <div style={{ fontSize: 8, color: C.dim, marginTop: 3 }}>realized daily vol, annualized ×√252 · 20d responsive / 60d stable</div>
              </div>
            </Panel>

            {/* Selected longs with editable notionals */}
            <Panel title={`Longs (${longs.length})`} right={longs.length ? <button onClick={() => setLongs([])} style={{ fontSize: 8.5, color: C.dim, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>clear</button> : null}>
              {!longs.length && <div style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>use "Long top-N" or click ⊕L in the rank →</div>}
              {longs.map(l => {
                const r = byCode[l.code] || {};
                return (
                  <div key={l.code} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                    <span style={{ width: 40, fontFamily: C.mono, fontSize: 11, fontWeight: 800, color: C.up2 }}>{l.code}</span>
                    <span style={{ width: 46, fontFamily: C.mono, fontSize: 9.5, color: carryColor(r.carry), textAlign: "right" }}>{sgn(r.carry, 1)}%</span>
                    <input style={{ ...inputStyle, flex: 1 }} type="number" min="0" step="1000000" value={l.notionalUsd}
                      onChange={e => setLegAmt(l.code, e.target.value)} />
                    <button onClick={() => removeLong(l.code)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, fontWeight: 800, padding: "0 2px" }}>×</button>
                  </div>
                );
              })}
            </Panel>

            {/* Selected shorts */}
            <Panel title={`Shorts (${shorts.length})`} right={shorts.length ? <button onClick={() => setShorts([])} style={{ fontSize: 8.5, color: C.dim, background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>clear</button> : null}>
              {!shorts.length && <div style={{ fontSize: 10, color: C.dim, fontStyle: "italic" }}>use "Short bottom-N" or click ⊕S in the rank →</div>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {shorts.map(code => {
                  const r = byCode[code] || {};
                  return (
                    <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(248,113,113,0.10)", border: `1px solid ${C.down}44`, borderRadius: 5, padding: "3px 6px" }}>
                      <span style={{ fontFamily: C.mono, fontSize: 10.5, fontWeight: 800, color: C.down }}>{code}</span>
                      <span style={{ fontFamily: C.mono, fontSize: 9, color: carryColor(r.carry) }}>{sgn(r.carry, 1)}%</span>
                      <button onClick={() => removeShort(code)} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 12, fontWeight: 800, padding: 0 }}>×</button>
                    </span>
                  );
                })}
              </div>
              <div style={{ fontSize: 8, color: C.dim, marginTop: 8 }}>short notionals are computed (vol-adjusted) →</div>
            </Panel>
          </div>

          {/* ── Results + rank ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

            {/* Book summary */}
            <Panel title="Sized book"
              right={bookLoading ? <span style={{ fontSize: 9, color: C.dim, fontWeight: 700 }}>sizing…</span>
                : book ? <span style={{ fontSize: 9, color: C.up2, fontWeight: 700, letterSpacing: ".06em" }}>{book.sizingMode === "vol_neutral" ? "VOL-NEUTRAL" : "$-NEUTRAL"} · {book.weighting === "inverse_vol" ? "INV-VOL" : "EQ-NOTL"} · {book.window}d</span> : null}>
              {bookErr && (
                <div style={{ marginBottom: 12, padding: "8px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
                  sizing unavailable — {bookErr} (LSEG history endpoint may be rate-limited; retry shortly)
                </div>
              )}
              {!book && !bookErr && (
                <div style={{ fontSize: 11, color: C.dim, fontStyle: "italic", padding: "6px 0" }}>
                  {longs.length && shorts.length ? "sizing…" : "select longs and shorts to size the book"}
                </div>
              )}
              {book && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                    <Stat label="Long notional" value={usdM(book.longNotionalUsd)} color={C.up2} sub={`$vol ${usd(book.longDailyVolUsd)}/d`} />
                    <Stat label="Short notional" value={usdM(book.shortNotionalUsd)} color={C.down} sub={`$vol ${usd(book.shortDailyVolUsd)}/d`} />
                    <Stat label="Book vol/day" value={usd(book.bookDailyVolUsd)} color={C.cyan}
                      sub={book.diversification != null ? `${(book.diversification * 100).toFixed(0)}% divers. vs $${(book.grossDailyVolUsd / 1000).toFixed(0)}k gross` : "full covariance"} />
                    <Stat label="Net carry / yr" value={usdM(book.netCarryUsdPerYr)} color={book.netCarryUsdPerYr >= 0 ? C.up2 : C.down} sub="fwd carry vs USD" />
                    <Stat label="Carry-to-vol" value={book.carryToVol != null ? book.carryToVol.toFixed(2) : "—"} color={C.violet} sub="carry ÷ ann. book vol" />
                    <Stat label="Book VaR95 / 99" value={usd(var95Book)} color={C.down} sub={`99: ${usd(var99Book)} (parametric, daily)`} />
                  </div>

                  {/* crash caveat */}
                  <div style={{ marginTop: 10, padding: "7px 10px", borderRadius: 6, background: "rgba(251,191,36,0.07)", border: `1px solid ${C.amber}33`, color: C.amber, fontSize: 8.5, lineHeight: 1.5 }}>
                    ⚠ carry is structurally short-vol &amp; negatively skewed — realized vol UNDERPRICES tail risk, especially for managed/pegged names (a low-vol high-carrier can be a crowded crash trade). Read carry-to-vol with the per-leg downside (95/99) below, not in isolation.
                  </div>

                  {/* legs table */}
                  <div style={{ marginTop: 12, overflowX: "auto" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
                      <thead><tr>
                        <th style={thL}>Side</th><th style={thL}>Pair</th><th style={th}>Rank</th>
                        <th style={th}>Notional</th><th style={th}>Carry%</th><th style={th}>Vol%/d</th>
                        <th style={th}>$vol/d</th><th style={th}>Down95%</th><th style={th}>Down99%</th>
                      </tr></thead>
                      <tbody>
                        {legs.map((lg, i) => (
                          <tr key={lg.side + lg.code + i}>
                            <td style={{ ...tdL, color: lg.side === "long" ? C.up2 : C.down, fontWeight: 800 }}>{lg.side === "long" ? "▲ L" : "▼ S"} {lg.code}</td>
                            <td style={{ ...tdL, color: C.sub }}>{lg.pair || "—"}</td>
                            <td style={td}>{lg.rank ?? "—"}</td>
                            <td style={td}>{usd(lg.notionalUsd)}</td>
                            <td style={{ ...td, color: carryColor(lg.carry) }}>{sgn(lg.carry, 2)}</td>
                            <td style={td}>{num(lg.dailyVolPct, 3)}</td>
                            <td style={td}>{usd(lg.dailyVolUsd)}</td>
                            <td style={{ ...td, color: C.down }}>{lg.histDown95Pct != null ? "-" + num(lg.histDown95Pct, 2) : "—"}</td>
                            <td style={{ ...td, color: C.down }}>{lg.histDown99Pct != null ? "-" + num(lg.histDown99Pct, 2) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {book.missingVol && book.missingVol.length > 0 && (
                    <div style={{ fontSize: 8.5, color: C.amber, marginTop: 6 }}>no vol history (excluded from sizing): {book.missingVol.join(", ")}</div>
                  )}
                </>
              )}
            </Panel>

            {/* 20y basket history — on demand (multi-year history pull per leg) */}
            <Panel title="Basket history — 20y cumulative P&L (monthly excess returns)"
              right={<button onClick={loadHist} disabled={histLoading || !longs.length || !shorts.length}
                style={{ fontSize: 9, fontWeight: 800, fontFamily: C.mono, borderRadius: 5, cursor: "pointer",
                         padding: "4px 12px", background: "rgba(34,211,238,0.12)",
                         border: `1px solid ${C.cyan}66`, color: histLoading ? C.dim : C.cyan, letterSpacing: ".06em" }}>
                {histLoading ? "LOADING…" : hist ? "RELOAD" : "LOAD 20Y"}
              </button>}>
              {histErr && (
                <div style={{ marginBottom: 10, padding: "8px 11px", borderRadius: 6, background: "rgba(251,191,36,0.10)", border: `1px solid ${C.amber}55`, color: C.amber, fontSize: 10, fontWeight: 600 }}>
                  history unavailable — {histErr}
                </div>
              )}
              {!hist && !histErr && (
                <div style={{ fontSize: 10, color: C.dim, fontStyle: "italic", padding: "4px 0" }}>
                  {longs.length && shorts.length
                    ? "press LOAD 20Y — replays TODAY'S signed notionals through ~20y of monthly excess returns (first pull is heavy: two decades of daily history per leg; cached 24h)"
                    : "select longs and shorts first"}
                </div>
              )}
              {hist && (<>
                <Plot
                  data={[{
                    x: hist.months, y: hist.cumPnlUsd, name: "Cumulative P&L",
                    type: "scatter", mode: "lines", line: { color: C.cyan, width: 1.6 },
                    fill: "tozeroy", fillcolor: "rgba(34,211,238,0.06)",
                    hovertemplate: "%{x}<br>$%{y:,.0f}<extra></extra>",
                  }]}
                  layout={{
                    paper_bgcolor: C.panel, plot_bgcolor: C.panel2, height: 240,
                    font: { color: C.sub, size: 9, family: "Inter,system-ui" },
                    margin: { l: 60, r: 14, t: 10, b: 26 }, hovermode: "x unified",
                    uirevision: "carry-hist",
                    xaxis: { gridcolor: C.border, tickfont: { size: 8 }, automargin: true },
                    yaxis: { gridcolor: C.border, zerolinecolor: "#475569", zeroline: true,
                             tickfont: { size: 8 }, tickprefix: "$", automargin: true },
                  }}
                  config={{ responsive: true, displayModeBar: false, displaylogo: false }}
                  style={{ width: "100%" }} useResizeHandler
                />
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.sub, marginTop: 6 }}>
                  total {usdM(hist.cumPnlUsd?.[hist.cumPnlUsd.length - 1])} over {hist.months?.length ?? 0} months ·
                  worst month {usdM(hist.monthlyPnlUsd?.length ? Math.min(...hist.monthlyPnlUsd) : null)} ·
                  coverage: {(hist.legs || []).map((l) => `${l.code} ${l.from ? l.from.slice(0, 7) : "—"}`).join(" · ")}
                </div>
                <div style={{ fontSize: 8.5, color: C.dim, marginTop: 4, lineHeight: 1.5 }}>{hist.note}</div>
              </>)}
            </Panel>

            {/* Yield rank (always shown) */}
            <Panel title="Yield rank — all traded EM + G10 (1M fwd-implied yield vs USD)"
              right={<span style={{ fontSize: 8.5, color: C.dim }}>⊕L long · ⊕S short · click to toggle</span>}>
              <div style={{ overflowX: "auto", maxHeight: 520, overflowY: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
                  <thead style={{ position: "sticky", top: 0, background: C.panel, zIndex: 1 }}>
                    <tr>
                      <th style={{ ...th, width: 30 }}>#</th><th style={thL}>Pair</th><th style={thL}>Ccy</th>
                      <th style={th}>Grp</th><th style={th}>Yield%</th><th style={th}>Carry%</th>
                      <th style={th} title={`${window}d rolling β of daily appreciation returns vs an equal-weight EM FX basket (${betas?.nBasket ?? "…"} names). Funders are often picked low-β — shorting a high-β name hedges EM risk-off; a low-β short is a purer funding trade.`}>β EM</th>
                      <th style={{ ...th, width: 34 }}>d</th><th style={{ ...th, textAlign: "center", width: 84 }}>L / S</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map(r => {
                      const isL = longSet.has(r.code), isS = shortSet.has(r.code);
                      const rowbg = isL ? "rgba(74,222,128,0.08)" : isS ? "rgba(248,113,113,0.08)" : "transparent";
                      return (
                        <tr key={r.code} style={{ background: rowbg }}>
                          <td style={{ ...td, color: C.dim }}>{r.rank}</td>
                          <td style={{ ...tdL, color: C.sub }}>{r.pair}</td>
                          <td style={{ ...tdL, fontWeight: 800, color: isL ? C.up2 : isS ? C.down : C.text }}>
                            {r.code}{r.ndf && <span style={{ fontSize: 7.5, color: C.dim, marginLeft: 4 }}>NDF</span>}
                          </td>
                          <td style={{ ...td, color: r.group === "G10" ? C.violet : C.dim, fontSize: 9 }}>{r.group}</td>
                          <td style={{ ...td, color: r.hasData ? C.text : C.dim }}>{r.hasData ? num(r.impliedYield, 2) : "—"}</td>
                          <td style={{ ...td, color: carryColor(r.carry) }}>{r.hasData ? sgn(r.carry, 2) : "—"}</td>
                          <td style={{ ...td, color: C.sub }}>{betas?.betas?.[r.code] != null ? num(betas.betas[r.code], 2) : "—"}</td>
                          <td style={{ ...td, color: C.dim, fontSize: 9 }}>{r.days1m ?? "—"}</td>
                          <td style={{ ...td, textAlign: "center" }}>
                            <button onClick={() => toggleLong(r.code)} disabled={!r.hasData} title="toggle long" style={{
                              fontSize: 9, fontWeight: 800, fontFamily: C.mono, borderRadius: 4, cursor: r.hasData ? "pointer" : "default",
                              padding: "2px 6px", marginRight: 3,
                              background: isL ? C.up : "transparent", border: `1px solid ${isL ? C.up : C.border}`,
                              color: isL ? "#04210f" : (r.hasData ? C.up2 : C.dim),
                            }}>L</button>
                            <button onClick={() => toggleShort(r.code)} disabled={!r.hasData} title="toggle short" style={{
                              fontSize: 9, fontWeight: 800, fontFamily: C.mono, borderRadius: 4, cursor: r.hasData ? "pointer" : "default",
                              padding: "2px 6px",
                              background: isS ? C.down : "transparent", border: `1px solid ${isS ? C.down : C.border}`,
                              color: isS ? "#2a0808" : (r.hasData ? C.down : C.dim),
                            }}>S</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

          </div>
        </div>

        <div style={{ fontSize: 8.5, color: C.dim, marginTop: 14, lineHeight: 1.6 }}>
          Rank on 1M forward-implied yield vs USD (CIP); NDF names use the offshore NDF-implied yield (NGN/EGP derived from broker outrights where the composite point is null). Day count is holiday-adjusted (US + local calendar, T+1 for CAD/TRY/RUB/PHP) — matches the pricer to &lt;1bp for 40/42; a couple of names (e.g. INR) can differ ≤1 day / ~6bp where the holiday-calendar source diverges from the pricer's. Vol = realized daily vol of the currency's appreciation return over the lookback window; book vol from the full covariance of the basket's returns (signed exposures). Sizing default: vol-neutral short leg, inverse-vol within-leg (JPMorgan / Bloomberg-GSAM convention). rank 120s (visible tab only) · sizing on selection change (history cached).
        </div>
      </div>
    </div>
  );
}
