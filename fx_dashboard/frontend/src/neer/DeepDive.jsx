// Deep-dive shell — top-level tab structure over the two deep-dive tools.
//   [ SGD NEER ]  → the existing SGD NEER monitor/analysis (NeerApp)
//   [ RISK UNITS ] → the vol-based position-sizing calculator (RiskUnits)
// Compact, dark, sticky tab bar. NeerApp keeps its own internal Monitor/Analysis
// sub-tabs and header; it simply renders under the SGD NEER top-tab.
import React, { useState } from "react";
import NeerApp from "./NeerApp.jsx";
import RiskUnits from "./RiskUnits.jsx";
import CarryBasket from "./CarryBasket.jsx";
import SgFundamentals from "./SgFundamentals.jsx";
import EmRules from "./EmRules.jsx";

// ── Dark theme (mirrors NeerApp / the pricer) ──
const C = {
  bg: "#0B1220", panel: "#0F172A", panel2: "#131C2E", border: "#1E293B",
  text: "#E2E8F0", sub: "#94A3B8", dim: "#64748B",
  up: "#4ADE80", up2: "#34D399", down: "#F87171",
  blue: "#3B82F6", cyan: "#22D3EE", amber: "#FBBF24",
  mono: "'JetBrains Mono','Fira Code',monospace",
};

const TABS = [["neer", "SGD NEER"], ["risk", "RISK UNITS"], ["carry", "CARRY BASKET"], ["fund", "SG FUNDAMENTALS"], ["rules", "EM RULES"]];

export default function DeepDive() {
  const [tab, setTab] = useState("neer");

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      {/* ── Sticky top-level tab bar ── */}
      <div style={{
        position: "sticky", top: 0, zIndex: 100,
        background: C.panel, borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", gap: 2, padding: "0 14px",
        boxShadow: "0 1px 0 rgba(0,0,0,0.35)",
      }}>
        <span style={{ fontSize: 9.5, fontWeight: 900, letterSpacing: ".18em", color: C.dim, marginRight: 16 }}>
          QQ · DEEP DIVE
        </span>
        {TABS.map(([id, lbl]) => {
          const on = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                fontSize: 11, fontWeight: 800, letterSpacing: ".1em",
                padding: "11px 20px", background: "transparent", border: "none", cursor: "pointer",
                color: on ? C.cyan : C.dim,
                borderBottom: `2px solid ${on ? C.cyan : "transparent"}`, marginBottom: -1,
                transition: "color .15s ease",
              }}
            >{lbl}</button>
          );
        })}
      </div>

      {/* ── Active tool ── */}
      {tab === "neer" ? <NeerApp /> : tab === "risk" ? <RiskUnits /> :
       tab === "carry" ? <CarryBasket /> : tab === "fund" ? <SgFundamentals /> : <EmRules />}
    </div>
  );
}
