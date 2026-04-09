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

export async function getHistory(ccy, days = 60, contributor = null) {
  let url = `${API}/history/${ccy}?days=${days}`;
  if (contributor) url += `&contributor=${encodeURIComponent(contributor)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`history ${ccy}: ${r.status}`);
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

// IPA: Workspace-computed forward for any tenor
export async function getIpaForward(pair, tenor) {
  const r = await fetch(`${API}/ipa/forward?pair=${pair}&tenor=${encodeURIComponent(tenor)}`);
  if (!r.ok) return { data: null, source: "unavailable" };
  return r.json();
}

// IPA: batch forward for multiple tenors
export async function getIpaForwardBatch(pair, tenors) {
  const r = await fetch(`${API}/ipa/forward-batch?pair=${pair}&tenors=${encodeURIComponent(tenors.join(","))}`);
  if (!r.ok) return { data: {}, source: "unavailable" };
  return r.json();
}

// Open a WebSocket channel. Returns { close } and emits onMsg(data) for each message.
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
