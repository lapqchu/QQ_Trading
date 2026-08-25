// InfoDoc — the per-tab user manual: a small ⓘ button (top-right of every
// deep-dive tab / sub-tab) that opens an overlay explaining WHY the tab exists,
// HOW to read each panel or column, where the same data appears elsewhere,
// exactly which numbers are live vs hardcoded-official vs model-estimated
// (the no-proxy-data rule), and references to go research further.
// Content lives in docs.jsx keyed by tab id; a missing key renders nothing.
import React, { useEffect, useState, useRef } from "react";
import { DOCS } from "./docs.jsx";

const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24", violet: "#A78BFA",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

// provenance classes for the DATA INTEGRITY table
const CLS = {
  live:     { label: "LIVE",     color: C.up,     desc: "fetched from the source at runtime" },
  official: { label: "OFFICIAL", color: C.cyan,   desc: "hardcoded transcription of a published official fact (source cited)" },
  model:    { label: "MODEL",    color: C.amber,  desc: "estimated / model output — not an observed fact" },
  gap:      { label: "GAP",      color: C.down,   desc: "not available — shown blank rather than proxied" },
};

function SectionHead({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: ".16em", color: C.cyan, margin: "18px 0 8px" }}>
      {children}
    </div>
  );
}

function Chip({ cls }) {
  const c = CLS[cls] || CLS.model;
  return (
    <span style={{ fontFamily: C.mono, fontSize: 8.5, fontWeight: 800, color: c.color,
                   border: `1px solid ${c.color}55`, background: `${c.color}14`,
                   borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {c.label}
    </span>
  );
}

function Overlay({ doc, onClose }) {
  // Close on backdrop click only when BOTH mousedown and click land on the backdrop —
  // otherwise selecting text in the doc and releasing over the backdrop (or grabbing
  // the overlay scrollbar in Firefox) would dismiss the manual mid-read.
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";   // freeze the page behind the manual
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const p = { fontSize: 11.5, color: C.sub, lineHeight: 1.7, margin: "0 0 8px" };

  return (
    <div
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(3,7,17,0.78)",
               display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "4vh 16px" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: C.panel, border: `1px solid #334155`, borderRadius: 10, maxWidth: 900, width: "100%",
                 padding: "18px 22px 26px", boxShadow: "0 24px 80px rgba(0,0,0,0.6)", marginBottom: "6vh" }}>

        {/* header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
                      borderBottom: `1px solid ${C.border}`, paddingBottom: 10 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 900, letterSpacing: ".2em", color: C.dim }}>USER MANUAL</div>
            <div style={{ fontSize: 15, fontWeight: 900, letterSpacing: ".04em", color: C.text, marginTop: 2 }}>{doc.title}</div>
            {doc.tagline && <div style={{ fontSize: 10.5, color: C.sub, marginTop: 3 }}>{doc.tagline}</div>}
          </div>
          <button onClick={onClose}
            style={{ background: C.panel2, color: C.sub, border: `1px solid ${C.border}`, borderRadius: 6,
                     padding: "4px 12px", fontSize: 10, fontWeight: 800, cursor: "pointer", letterSpacing: ".06em" }}>
            ESC ✕
          </button>
        </div>

        {/* why this exists */}
        {doc.why && (<>
          <SectionHead>WHY THIS TAB EXISTS</SectionHead>
          {doc.why.map((t, i) => <p key={i} style={p}>{t}</p>)}
        </>)}

        {/* how to read — panel by panel / column by column */}
        {doc.how && (<>
          <SectionHead>HOW TO READ IT — {doc.howLabel || "PANEL BY PANEL"}</SectionHead>
          {doc.how.map((s, i) => (
            <div key={i} style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8,
                                  padding: "9px 12px", marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".08em", color: C.text }}>{s.name}</div>
              {s.what && <div style={{ ...p, marginTop: 5 }}><b style={{ color: C.sub }}>What it shows:</b> {s.what}</div>}
              {s.read && <div style={p}><b style={{ color: C.sub }}>How to read it:</b> {s.read}</div>}
              {s.why && <div style={{ ...p, marginBottom: 0 }}><b style={{ color: C.amber }}>Why it matters:</b> {s.why}</div>}
              {s.ref && <div style={{ fontSize: 10, color: C.violet, marginTop: 5 }}>📖 {s.ref}</div>}
            </div>
          ))}
        </>)}

        {/* relation to other tabs / overlaps */}
        {doc.overlaps && (<>
          <SectionHead>SAME DATA, OTHER TABS — WHY THE OVERLAP</SectionHead>
          {doc.overlaps.map((t, i) => <p key={i} style={p}>{t}</p>)}
        </>)}

        {/* data integrity */}
        {doc.integrity && (<>
          <SectionHead>DATA INTEGRITY — WHAT IS ACTUALLY REAL HERE</SectionHead>
          <div style={{ fontSize: 10, color: C.dim, marginBottom: 8, lineHeight: 1.6 }}>
            House rule: no proxy or filler data, ever. {Object.values(CLS).map((c, i) => (
              <span key={c.label}>{i > 0 && " · "}<b style={{ color: c.color }}>{c.label}</b> = {c.desc}</span>
            ))}.
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {doc.integrity.map((r, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "5px 8px 5px 0", whiteSpace: "nowrap", verticalAlign: "top" }}><Chip cls={r.cls} /></td>
                  <td style={{ padding: "5px 0", fontSize: 10.5, color: C.text, verticalAlign: "top", whiteSpace: "nowrap", paddingRight: 12 }}>{r.item}</td>
                  <td style={{ padding: "5px 0", fontSize: 10.5, color: C.sub, lineHeight: 1.55 }}>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>)}

        {/* go deeper */}
        {doc.refs && (<>
          <SectionHead>GO DEEPER — REFERENCES &amp; SEARCH CUES</SectionHead>
          {doc.refs.map((r, i) => (
            <div key={i} style={{ marginBottom: 7 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{r.label}</span>
              {r.note && <span style={{ fontSize: 10.5, color: C.sub }}> — {r.note}</span>}
              {r.search && (
                <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.violet, marginTop: 2 }}>
                  🔍 {r.search.join("  ·  ")}
                </div>
              )}
            </div>
          ))}
        </>)}
      </div>
    </div>
  );
}

// The ⓘ button. Place at the top-right of every tab / sub-tab bar.
export function InfoButton({ docKey, style }) {
  const [open, setOpen] = useState(false);
  const doc = DOCS[docKey];
  if (!doc) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title="How to read this tab — user manual"
        style={{ width: 20, height: 20, borderRadius: "50%", background: "transparent",
                 border: `1px solid ${C.dim}`, color: C.dim, fontSize: 11, fontWeight: 800,
                 cursor: "pointer", lineHeight: 1, display: "inline-flex", alignItems: "center",
                 justifyContent: "center", flex: "0 0 auto", fontFamily: "Georgia,serif", fontStyle: "italic",
                 transition: "color .15s ease, border-color .15s ease", ...style }}
        onMouseEnter={(e) => { e.currentTarget.style.color = C.cyan; e.currentTarget.style.borderColor = C.cyan; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = C.dim; }}>
        i
      </button>
      {open && <Overlay doc={doc} onClose={() => setOpen(false)} />}
    </>
  );
}
