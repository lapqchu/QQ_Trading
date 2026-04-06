import { useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ComposedChart, Area,
  Cell, ReferenceLine, Label
} from "recharts";

const spotMid = 32.024;

const outrightData = [
  { tenor: "1M", bid: 32.091, ask: 32.111, mid: 32.101, swapPts: 77.0, days: 30 },
  { tenor: "2M", bid: 32.141, ask: 32.180, mid: 32.160, swapPts: 136.5, days: 62 },
  { tenor: "3M", bid: 32.151, ask: 32.190, mid: 32.171, swapPts: 146.5, days: 91 },
  { tenor: "6M", bid: 32.161, ask: 32.200, mid: 32.181, swapPts: 156.5, days: 183 },
  { tenor: "9M", bid: 32.141, ask: 32.190, mid: 32.166, swapPts: 141.5, days: 275 },
  { tenor: "12M", bid: 32.131, ask: 32.180, mid: 32.156, swapPts: 131.5, days: 365 },
  { tenor: "2Y", bid: 32.261, ask: 32.381, mid: 32.321, swapPts: 297.0, days: 731 },
];

const fwdFwd1MData = [
  { tenor: "1Mx2M", spread: 59.5 },
  { tenor: "1Mx3M", spread: 69.5 },
  { tenor: "1Mx6M", spread: 79.5 },
  { tenor: "1Mx9M", spread: 64.5 },
  { tenor: "1Mx12M", spread: 54.5 },
];

const fwdFwd12MData = [
  { tenor: "12Mx18M*", spread: 82.7 },
  { tenor: "12Mx24M", spread: 165.5 },
];

const quarterlyData = [
  { tenor: "3Mx6M", spread: 10.0 },
  { tenor: "6Mx9M", spread: -15.0 },
  { tenor: "9Mx12M", spread: -10.0 },
];

const CustomTooltipOutright = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    return (
      <div className="bg-gray-900 text-white p-3 rounded-lg shadow-xl border border-gray-700" style={{ fontSize: 13 }}>
        <p className="font-bold text-blue-300 mb-1">{d.tenor} NDF</p>
        <p>Bid: <span className="text-green-400">{d.bid.toFixed(3)}</span></p>
        <p>Ask: <span className="text-red-400">{d.ask.toFixed(3)}</span></p>
        <p>Mid: <span className="text-yellow-300">{d.mid.toFixed(3)}</span></p>
        <p className="mt-1 pt-1 border-t border-gray-600">
          Swap Pts: <span className="font-bold text-cyan-300">{d.swapPts > 0 ? "+" : ""}{d.swapPts.toFixed(1)} pips</span>
        </p>
        <p className="text-gray-400 text-xs mt-1">{d.days} days to maturity</p>
      </div>
    );
  }
  return null;
};

const CustomTooltipFwd = ({ active, payload }) => {
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    return (
      <div className="bg-gray-900 text-white p-3 rounded-lg shadow-xl border border-gray-700" style={{ fontSize: 13 }}>
        <p className="font-bold text-emerald-300 mb-1">{d.tenor}</p>
        <p>Spread: <span className={`font-bold ${d.spread >= 0 ? "text-green-400" : "text-red-400"}`}>
          {d.spread > 0 ? "+" : ""}{d.spread.toFixed(1)} pips
        </span></p>
        {d.tenor.includes("*") && <p className="text-gray-400 text-xs mt-1">18M interpolated from 12M & 2Y</p>}
      </div>
    );
  }
  return null;
};

const SectionHeader = ({ title, subtitle }) => (
  <div className="mb-3">
    <h3 className="text-base font-bold text-white">{title}</h3>
    {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
  </div>
);

const DataTable = ({ data, columns }) => (
  <div className="overflow-x-auto rounded-lg border border-gray-700">
    <table className="w-full text-xs">
      <thead>
        <tr className="bg-gray-800">
          {columns.map((col) => (
            <th key={col.key} className="px-3 py-2 text-left text-gray-300 font-semibold">{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i} className={i % 2 === 0 ? "bg-gray-900" : "bg-gray-850"} style={{ backgroundColor: i % 2 === 0 ? "#111827" : "#1a2234" }}>
            {columns.map((col) => (
              <td key={col.key} className={`px-3 py-1.5 ${col.className || "text-gray-300"}`}>
                {col.format ? col.format(row[col.key], row) : row[col.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function TWDNDFDashboard() {
  const [activeTab, setActiveTab] = useState("curve");

  const tabs = [
    { id: "curve", label: "Outright Curve" },
    { id: "fwdfwd", label: "Fwd-Fwd Spreads" },
    { id: "quarterly", label: "Quarterly Rolls" },
    { id: "table", label: "Data Table" },
  ];

  return (
    <div className="bg-gray-950 text-white min-h-screen p-4" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div className="mb-4 pb-3 border-b border-gray-800">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-bold text-white">USDTWD NDF Swap Points</h1>
            <p className="text-xs text-gray-400 mt-1">01-Apr-2026 &middot; Source: LSEG</p>
          </div>
          <div className="flex gap-4 text-xs">
            <div className="bg-gray-800 px-3 py-1.5 rounded-md">
              <span className="text-gray-400">Spot Mid</span>
              <span className="ml-2 font-mono font-bold text-yellow-300">{spotMid.toFixed(3)}</span>
            </div>
            <div className="bg-gray-800 px-3 py-1.5 rounded-md">
              <span className="text-gray-400">Bid/Ask</span>
              <span className="ml-2 font-mono text-green-400">32.009</span>
              <span className="text-gray-500 mx-1">/</span>
              <span className="font-mono text-red-400">32.039</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-900 p-1 rounded-lg w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === tab.id
                ? "bg-blue-600 text-white shadow-lg"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Chart Panels */}
      {activeTab === "curve" && (
        <div>
          <SectionHeader
            title="Outright NDF Swap Points vs Spot"
            subtitle="Swap points = NDF outright mid − spot mid (in pips, 1 pip = 0.001)"
          />
          <div style={{ width: "100%", height: 380 }}>
            <ResponsiveContainer>
              <ComposedChart data={outrightData} margin={{ top: 20, right: 30, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="tenor" stroke="#9CA3AF" tick={{ fontSize: 12 }} />
                <YAxis stroke="#9CA3AF" tick={{ fontSize: 11 }} label={{ value: "Swap Pts (pips)", angle: -90, position: "insideLeft", style: { fill: "#9CA3AF", fontSize: 11 } }} />
                <Tooltip content={<CustomTooltipOutright />} />
                <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="4 4" />
                <Bar dataKey="swapPts" radius={[6, 6, 0, 0]} barSize={48}>
                  {outrightData.map((entry, i) => (
                    <Cell key={i} fill={entry.swapPts >= 150 ? "#3B82F6" : entry.swapPts >= 100 ? "#60A5FA" : "#93C5FD"} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="swapPts" stroke="#EF4444" strokeWidth={2.5} dot={{ r: 5, fill: "#EF4444", stroke: "#fff", strokeWidth: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 bg-gray-900 rounded-lg p-3 text-xs text-gray-300 leading-relaxed">
            <span className="text-yellow-400 font-semibold">Key: </span>
            Curve humps at 6M (+156.5) then inverts through 12M (+131.5) before steepening sharply to 2Y (+297.0).
            The 6M-12M inversion signals the market pricing TWD strength or compressed USD-TWD rate differentials in that sector.
          </div>
        </div>
      )}

      {activeTab === "fwdfwd" && (
        <div>
          <SectionHeader
            title="Forward-Forward Spreads"
            subtitle="Spread = far-leg outright mid − near-leg outright mid (pips)"
          />
          <div className="grid grid-cols-1 gap-4" style={{ gridTemplateColumns: "1fr" }}>
            <div>
              <p className="text-xs text-blue-400 font-semibold mb-2">1M Start</p>
              <div style={{ width: "100%", height: 250 }}>
                <ResponsiveContainer>
                  <BarChart data={fwdFwd1MData} margin={{ top: 15, right: 30, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="tenor" stroke="#9CA3AF" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#9CA3AF" tick={{ fontSize: 11 }} />
                    <Tooltip content={<CustomTooltipFwd />} />
                    <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="4 4" />
                    <Bar dataKey="spread" radius={[6, 6, 0, 0]} barSize={44}>
                      {fwdFwd1MData.map((e, i) => (
                        <Cell key={i} fill={e.spread >= 0 ? "#10B981" : "#EF4444"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <p className="text-xs text-orange-400 font-semibold mb-2">12M Start</p>
              <div style={{ width: "100%", height: 250 }}>
                <ResponsiveContainer>
                  <BarChart data={fwdFwd12MData} margin={{ top: 15, right: 30, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="tenor" stroke="#9CA3AF" tick={{ fontSize: 11 }} />
                    <YAxis stroke="#9CA3AF" tick={{ fontSize: 11 }} />
                    <Tooltip content={<CustomTooltipFwd />} />
                    <ReferenceLine y={0} stroke="#6B7280" strokeDasharray="4 4" />
                    <Bar dataKey="spread" radius={[6, 6, 0, 0]} barSize={44}>
                      {fwdFwd12MData.map((e, i) => (
                        <Cell key={i} fill="#F59E0B" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-gray-500 italic mt-1">*18M interpolated linearly between 12M and 2Y outrights</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === "quarterly" && (
        <div>
          <SectionHeader
            title="Quarterly Roll Spreads (3M intervals)"
            subtitle="Measures the incremental swap points earned rolling forward each quarter"
          />
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <ComposedChart data={quarterlyData} margin={{ top: 20, right: 30, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="tenor" stroke="#9CA3AF" tick={{ fontSize: 12 }} />
                <YAxis stroke="#9CA3AF" tick={{ fontSize: 11 }} label={{ value: "Spread (pips)", angle: -90, position: "insideLeft", style: { fill: "#9CA3AF", fontSize: 11 } }} />
                <Tooltip content={<CustomTooltipFwd />} />
                <ReferenceLine y={0} stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="6 3">
                  <Label value="zero line" position="right" fill="#F59E0B" fontSize={10} />
                </ReferenceLine>
                <Bar dataKey="spread" radius={[6, 6, 0, 0]} barSize={56}>
                  {quarterlyData.map((e, i) => (
                    <Cell key={i} fill={e.spread >= 0 ? "#8B5CF6" : "#EC4899"} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="spread" stroke="#6366F1" strokeWidth={2.5} dot={{ r: 6, fill: "#6366F1", stroke: "#fff", strokeWidth: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 bg-gray-900 rounded-lg p-3 text-xs text-gray-300 leading-relaxed">
            <span className="text-pink-400 font-semibold">Signal: </span>
            6Mx9M (−15.0) and 9Mx12M (−10.0) are both negative — the curve inverts in this sector.
            This implies the market expects TWD to strengthen (or USD rates to fall relative to TWD rates)
            in the second half of the forward horizon. Only 3Mx6M remains marginally positive (+10.0).
          </div>
        </div>
      )}

      {activeTab === "table" && (
        <div className="space-y-5">
          <div>
            <SectionHeader title="Outright NDF Curve" />
            <DataTable
              data={outrightData}
              columns={[
                { key: "tenor", label: "Tenor", className: "font-bold text-blue-300" },
                { key: "bid", label: "Bid", format: (v) => v.toFixed(3), className: "font-mono text-green-400" },
                { key: "ask", label: "Ask", format: (v) => v.toFixed(3), className: "font-mono text-red-400" },
                { key: "mid", label: "Mid", format: (v) => v.toFixed(3), className: "font-mono text-yellow-300" },
                { key: "swapPts", label: "Swap Pts", format: (v) => (v > 0 ? "+" : "") + v.toFixed(1), className: "font-mono font-bold text-cyan-300" },
                { key: "days", label: "Days", className: "text-gray-400" },
              ]}
            />
          </div>
          <div>
            <SectionHeader title="Forward-Forward Spreads (pips)" />
            <DataTable
              data={[...fwdFwd1MData, ...fwdFwd12MData, ...quarterlyData]}
              columns={[
                { key: "tenor", label: "Tenor Pair", className: "font-bold text-emerald-300" },
                {
                  key: "spread",
                  label: "Spread",
                  format: (v) => (v > 0 ? "+" : "") + v.toFixed(1),
                  className: "font-mono font-bold",
                },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
