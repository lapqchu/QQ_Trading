// Backend API client + WebSocket helpers
const API = "/api";
const WS_BASE = (() => {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}`;
})();

export async function getCurrencies() {
  const r = await fetch(`${API}/currencies`);
  if (!r.ok) throw new Error(`currencies: ${r.status}`);
  return r.json();
}

export async function getSnapshot(ccy) {
  const r = await fetch(`${API}/snapshot/${ccy}`);
  if (!r.ok) throw new Error(`snapshot ${ccy}: ${r.status}`);
  return r.json();
}

export async function getHistory(ccy, opts = {}) {
  const { period = "1Y", contributor = null, extraRics = null, tenor = null } = opts || {};
  const params = new URLSearchParams();
  params.set("period", period);
  if (contributor) params.set("contributor", contributor);
  if (extraRics && extraRics.length) params.set("extra_rics", Array.isArray(extraRics) ? extraRics.join(",") : extraRics);
  if (tenor) params.set("tenor", tenor);
  const r = await fetch(`${API}/history/${ccy}?${params.toString()}`);
  if (!r.ok) throw new Error(`history ${ccy}: ${r.status}`);
  return r.json();
}

export async function getHistoryCustom({ ccy, near, far, period = "1Y", contributor = null }) {
  const params = new URLSearchParams();
  params.set("near", near);
  params.set("far", far);
  params.set("period", period);
  if (contributor) params.set("contributor", contributor);
  const r = await fetch(`${API}/history-custom/${ccy}?${params.toString()}`);
  if (!r.ok) throw new Error(`history-custom ${ccy}: ${r.status}`);
  return r.json();
}

export async function t1Backfill(rics) {
  const list = Array.isArray(rics) ? rics : [rics];
  if (!list.length) return {};
  const params = new URLSearchParams();
  params.set("rics", list.join(","));
  const r = await fetch(`${API}/t1-backfill?${params.toString()}`, { method: "POST" });
  if (!r.ok) throw new Error(`t1-backfill: ${r.status}`);
  return r.json();
}

export async function liveStart(ccy) {
  const r = await fetch(`${API}/live/start?ccy=${ccy}`, { method: "POST" });
  return r.json();
}

export async function liveStop(ccy) {
  const r = await fetch(`${API}/live/stop${ccy ? `?ccy=${ccy}` : ""}`, { method: "POST" });
  return r.json();
}

export async function getStatus() {
  const r = await fetch(`${API}/status`);
  return r.json();
}

export async function getIpaForward(pair, tenor) {
  const r = await fetch(`${API}/ipa/forward?pair=${pair}&tenor=${encodeURIComponent(tenor)}`);
  if (!r.ok) return { data: null, source: "unavailable" };
  return r.json();
}

export async function getIpaForwardBatch(pair, tenors) {
  const r = await fetch(`${API}/ipa/forward-batch?pair=${pair}&tenors=${encodeURIComponent(tenors.join(","))}`);
  if (!r.ok) return { data: {}, source: "unavailable" };
  return r.json();
}

export function openChannel(channel, onMsg, onOpen, onClose) {
  let ws = null;
  let stopped = false;
  let retries = 0;
  function connect() {
    if (stopped) return;
    ws = new WebSocket(`${WS_BASE}/ws/${channel}`);
    ws.onopen = () => { retries = 0; onOpen && onOpen(); };
    ws.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        onMsg(payload.data);
      } catch (err) { console.error("ws parse", err); }
    };
    ws.onclose = () => {
      onClose && onClose();
      if (!stopped) {
        retries = Math.min(retries + 1, 6);
        setTimeout(connect, 500 * 2 ** retries);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  connect();
  return {
    close: () => { stopped = true; try { ws && ws.close(); } catch {} },
  };
}
