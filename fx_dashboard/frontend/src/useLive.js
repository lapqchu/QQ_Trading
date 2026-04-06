// React hook: merges snapshot + live WS updates by RIC → flat quotes map
import { useEffect, useRef, useState, useCallback } from "react";
import { getSnapshot, liveStart, liveStop, openChannel } from "./api.js";

export function useQuotes(ccy, liveOn) {
  const [snap, setSnap] = useState(null);
  const [quotes, setQuotes] = useState({});        // ric → {bid,ask,mid,ts}
  const [err, setErr] = useState(null);
  const channelsRef = useRef([]);

  // Snapshot on ccy change
  useEffect(() => {
    let cancelled = false;
    setErr(null); setSnap(null);
    getSnapshot(ccy).then((s) => {
      if (cancelled) return;
      setSnap(s);
      // prime quotes from snapshot
      const q = {};
      if (s.spot) q[s.spot.ric] = s.spot;
      for (const m of Object.keys(s.tenors || {})) q[s.tenors[m].ric] = s.tenors[m];
      for (const m of Object.keys(s.sofr || {})) q[s.sofr[m].ric] = s.sofr[m];
      setQuotes(q);
    }).catch((e) => !cancelled && setErr(e.message));
    return () => { cancelled = true; };
  }, [ccy]);

  // Live streaming lifecycle
  useEffect(() => {
    if (!liveOn || !snap) return;
    liveStart(ccy).catch((e) => setErr(`liveStart: ${e.message}`));

    const onTick = (msg) => {
      if (!msg || !msg.ric) return;
      setQuotes((prev) => ({ ...prev, [msg.ric]: { ...prev[msg.ric], ...msg } }));
    };
    channelsRef.current = [
      openChannel("spot", onTick),
      openChannel("forwards", onTick),
      openChannel("brokers", onTick),
    ];
    return () => {
      channelsRef.current.forEach((c) => c.close());
      channelsRef.current = [];
      liveStop(ccy).catch(() => {});
    };
  }, [liveOn, ccy, snap]);

  const refreshSnapshot = useCallback(async () => {
    const s = await getSnapshot(ccy);
    setSnap(s);
  }, [ccy]);

  return { snap, quotes, err, refreshSnapshot };
}
