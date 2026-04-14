// React hook: merges snapshot + live WS updates by RIC → flat quotes map.
// Computes freshness client-side from snapshot.freshnessThresholdsSec on each tick.
import { useEffect, useRef, useState, useCallback } from "react";
import { getSnapshot, liveStart, liveStop, openChannel } from "./api.js";

function computeFreshness(ageSec, thresholds) {
  if (ageSec == null) return "unknown";
  if (ageSec <= (thresholds?.fresh ?? 600)) return "fresh";
  if (ageSec <= (thresholds?.stale ?? 3600)) return "stale";
  return "very_stale";
}

export function useQuotes(ccy, liveOn) {
  const [snap, setSnap] = useState(null);
  const [quotes, setQuotes] = useState({});
  const [err, setErr] = useState(null);
  const channelsRef = useRef([]);
  const thresholdsRef = useRef({ fresh: 600, stale: 3600 });

  useEffect(() => {
    let cancelled = false;
    setErr(null); setSnap(null);
    getSnapshot(ccy).then((s) => {
      if (cancelled) return;
      setSnap(s);
      thresholdsRef.current = s.freshnessThresholdsSec || { fresh: 600, stale: 3600 };
      const q = {};
      if (s.spot) q[s.spot.ric] = s.spot;
      // seed from tenor sources (new contract)
      for (const m of Object.keys(s.tenors || {})) {
        const t = s.tenors[m];
        for (const [name, src] of Object.entries(t.sources || {})) {
          if (src?.ric) q[src.ric] = { ...src, sourceName: name, tenorM: m };
        }
      }
      for (const m of Object.keys(s.sofr || {})) q[s.sofr[m].ric] = s.sofr[m];
      setQuotes(q);
    }).catch((e) => !cancelled && setErr(e.message));
    return () => { cancelled = true; };
  }, [ccy]);

  useEffect(() => {
    if (!liveOn || !snap) return;
    liveStart(ccy).catch((e) => setErr(`liveStart: ${e.message}`));

    const onTick = (msg) => {
      if (!msg || !msg.ric) return;
      const ts = msg.ts ?? Date.now() / 1000;
      const ageSec = msg.ageSec ?? 0;
      const freshness = msg.freshness ?? computeFreshness(ageSec, thresholdsRef.current);
      setQuotes((prev) => ({
        ...prev,
        [msg.ric]: { ...prev[msg.ric], ...msg, ts, ageSec, freshness, timact: msg.timact ?? prev[msg.ric]?.timact },
      }));
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
    thresholdsRef.current = s.freshnessThresholdsSec || { fresh: 600, stale: 3600 };
  }, [ccy]);

  return { snap, quotes, err, refreshSnapshot };
}
