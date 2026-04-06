"""
Market data service — orchestrates snapshots + streaming for the FX dashboard.

Responsibilities:
- Build per-currency snapshots (spot + all forward tenors + SOFR anchors)
- Maintain cached last-known values (for REST /snapshot endpoint)
- Drive three streaming channels for live mode:
    • spot          → every tick (fanout immediately)
    • forwards      → every 15s (debounced/throttled, one tick per RIC per 15s)
    • brokers       → every tick (fanout for broker monitor)
- Provide history fetch (on-demand, never auto-refreshed)
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import Dict, List, Any, Callable, Optional, Set
from dataclasses import dataclass, field

from lseg_client import LsegClient
from ric_config import (
    CURRENCIES, SOFR_RICS, CurrencyConfig,
    all_outright_rics, all_broker_rics,
)

log = logging.getLogger(__name__)

FIELDS_QUOTE = ["BID", "ASK", "PRIMACT_1", "SEC_ACT_1", "TRDPRC_1", "HST_CLOSE", "GEN_VAL1", "TIMACT"]
THROTTLE_FORWARD_SEC = 15.0


@dataclass
class Quote:
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    ts: Optional[float] = None   # unix ts of last update

    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2
        return None


class MarketService:
    def __init__(self, lseg: LsegClient):
        self.lseg = lseg
        # cached quotes by RIC
        self._quotes: Dict[str, Quote] = {}
        # throttling buckets for forwards — last emit time per RIC
        self._last_fwd_emit: Dict[str, float] = {}
        # subscribers: async queues by channel tag
        self._subscribers: Dict[str, Set[asyncio.Queue]] = {
            "spot": set(),
            "forwards": set(),
            "brokers": set(),
        }
        self._active_ccy: Optional[str] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    # ────────────────── snapshot ──────────────────
    def build_snapshot(self, ccy: str) -> Dict[str, Any]:
        """Pull a one-shot snapshot for a currency — used on page load / ccy-switch.
        Returns both T (current) and T1 (previous close) for day-change calculations."""
        cfg = CURRENCIES[ccy]
        rics = all_outright_rics(ccy) + list(SOFR_RICS.values())

        # T (current) — live snapshot
        data_t = self.lseg.get_snapshot(rics, FIELDS_QUOTE)
        now = time.time()
        for ric, fields in data_t.items():
            q = Quote(
                bid=_num(fields.get("BID")) or _num(fields.get("PRIMACT_1")),
                ask=_num(fields.get("ASK")) or _num(fields.get("SEC_ACT_1")),
                last=_num(fields.get("TRDPRC_1")) or _num(fields.get("HST_CLOSE")) or _num(fields.get("GEN_VAL1")),
                ts=now,
            )
            self._quotes[ric] = q

        # T1 (previous close) — from daily history, take last completed bar
        t1_quotes: Dict[str, Quote] = {}
        try:
            hist = self.lseg.get_history(
                rics=rics, fields=["BID", "ASK", "TRDPRC_1"],
                interval="daily", count=2,
            )
            for ric, bars in hist.items():
                if not bars: continue
                # Last bar = most recent close. If same as T, use prior bar.
                bar = bars[-1] if len(bars) == 1 else bars[-2]
                t1_quotes[ric] = Quote(
                    bid=_num(bar.get("BID")), ask=_num(bar.get("ASK")),
                    last=_num(bar.get("TRDPRC_1")), ts=None,
                )
        except Exception as e:
            log.warning("T1 fetch failed: %s", e)

        return self._serialize_snapshot(cfg, t1_quotes)

    def _serialize_snapshot(self, cfg: CurrencyConfig, t1_quotes: Optional[Dict[str, 'Quote']] = None) -> Dict[str, Any]:
        """Package cached quotes into a dashboard-friendly structure with T and T1."""
        t1 = t1_quotes or {}

        def _q(ric, dk="T"):
            if dk == "T1":
                return t1.get(ric, Quote())
            return self._quotes.get(ric, Quote())

        def _ser(ric, dk="T"):
            q = _q(ric, dk)
            return {"bid": q.bid, "ask": q.ask, "mid": q.mid(), "last": q.last, "ts": q.ts}

        # Spot
        spot_t = _ser(cfg.spot_ric, "T")
        spot_t1 = _ser(cfg.spot_ric, "T1")

        # NDF/Deliverable tenors
        tenors = {}
        for m in cfg.tenors_m:
            ric = cfg.outright_ric(m)
            # Approximate days to tenor
            days_approx = {1:30, 2:61, 3:91, 6:182, 9:273, 12:365, 18:547, 24:730}.get(m, m*30)
            tenors[m] = {
                "ric": ric, "days": days_approx,
                "T": _ser(ric, "T"), "T1": _ser(ric, "T1"),
            }
            # For each tenor, check if we got meaningful data. If bid/ask/last are all None, mark as missing.
            tenors[m]["hasData"] = bool(tenors[m]["T"]["bid"] is not None or tenors[m]["T"]["ask"] is not None or tenors[m]["T"]["last"] is not None)

        # SOFR curve
        sofr = {}
        for m, ric in SOFR_RICS.items():
            sofr[m] = {
                "ric": ric,
                "T": _ser(ric, "T"), "T1": _ser(ric, "T1"),
            }

        return {
            "ccy": cfg.code, "pair": cfg.pair, "kind": cfg.kind,
            "pipFactor": cfg.pip_factor, "outrightDp": cfg.outright_dp, "pipDp": cfg.pip_dp,
            "tenorsM": cfg.tenors_m, "spreadPack": cfg.spread_pack,
            "weeklyTenors": [0.25, 0.5, 0.75],
            "displayTenors": cfg.display_tenors,
            "spot": {"ric": cfg.spot_ric, "T": spot_t, "T1": spot_t1},
            "tenors": tenors, "sofr": sofr,
        }

    # ────────────────── live streaming ──────────────────
    def start_streams(self, ccy: str):
        """Open three streams for active currency: spot (tick), forwards (15s), brokers (tick)."""
        self._active_ccy = ccy
        cfg = CURRENCIES[ccy]

        # Spot — tick granularity
        self.lseg.subscribe(
            tag=f"spot-{ccy}",
            rics=[cfg.spot_ric],
            fields=FIELDS_QUOTE,
            on_update=lambda ric, f: self._on_spot_tick(ric, f),
        )
        # Forwards — tick subscription but throttled to 15s per RIC server-side
        fwd_rics = [cfg.outright_ric(m) for m in cfg.tenors_m]
        self.lseg.subscribe(
            tag=f"fwd-{ccy}",
            rics=fwd_rics,
            fields=FIELDS_QUOTE,
            on_update=lambda ric, f: self._on_fwd_tick(ric, f),
        )
        # Brokers — tick (user said freely use broker streams)
        br_rics = all_broker_rics(ccy)
        if br_rics:
            self.lseg.subscribe(
                tag=f"brk-{ccy}",
                rics=br_rics,
                fields=FIELDS_QUOTE,
                on_update=lambda ric, f: self._on_broker_tick(ric, f),
            )

    def stop_streams(self, ccy: Optional[str] = None):
        c = ccy or self._active_ccy
        if not c: return
        for prefix in ("spot", "fwd", "brk"):
            self.lseg.unsubscribe(f"{prefix}-{c}")

    # Stream handlers — update cache + fanout to WebSocket subscribers
    def _on_spot_tick(self, ric: str, updates: Dict[str, Any]):
        q = self._apply_update(ric, updates)
        self._fanout("spot", {"ric": ric, "bid": q.bid, "ask": q.ask, "mid": q.mid(), "ts": q.ts})

    def _on_fwd_tick(self, ric: str, updates: Dict[str, Any]):
        q = self._apply_update(ric, updates)
        now = time.time()
        last = self._last_fwd_emit.get(ric, 0.0)
        if now - last >= THROTTLE_FORWARD_SEC:
            self._last_fwd_emit[ric] = now
            self._fanout("forwards", {"ric": ric, "bid": q.bid, "ask": q.ask, "mid": q.mid(), "ts": q.ts})

    def _on_broker_tick(self, ric: str, updates: Dict[str, Any]):
        q = self._apply_update(ric, updates)
        self._fanout("brokers", {"ric": ric, "bid": q.bid, "ask": q.ask, "ts": q.ts})

    def _apply_update(self, ric: str, updates: Dict[str, Any]) -> Quote:
        q = self._quotes.get(ric) or Quote()
        if "BID" in updates: q.bid = _num(updates["BID"])
        if "ASK" in updates: q.ask = _num(updates["ASK"])
        if "TRDPRC_1" in updates: q.last = _num(updates["TRDPRC_1"])
        if "PRIMACT_1" in updates and q.bid is None: q.bid = _num(updates["PRIMACT_1"])
        if "SEC_ACT_1" in updates and q.ask is None: q.ask = _num(updates["SEC_ACT_1"])
        q.ts = time.time()
        self._quotes[ric] = q
        return q

    # ────────────────── pub/sub (WebSocket fanout) ──────────────────
    def subscribe_channel(self, channel: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.setdefault(channel, set()).add(q)
        return q

    def unsubscribe_channel(self, channel: str, q: asyncio.Queue):
        s = self._subscribers.get(channel)
        if s and q in s: s.discard(q)

    def _fanout(self, channel: str, msg: Dict[str, Any]):
        """Called from SDK callback thread — schedule async put on loop."""
        if not self._loop: return
        subs = list(self._subscribers.get(channel, set()))
        for q in subs:
            try:
                self._loop.call_soon_threadsafe(_safe_put, q, msg)
            except Exception as e:
                log.warning("fanout %s: %s", channel, e)

    # ────────────────── history (on demand) ──────────────────
    def get_history(self, ccy: str, days: int = 60) -> Dict[str, Any]:
        """Historical daily bars for all tenors of a currency."""
        cfg = CURRENCIES[ccy]
        rics = all_outright_rics(ccy)
        from datetime import datetime, timedelta
        end = datetime.utcnow().date()
        start = end - timedelta(days=days + 20)  # padding for non-trading days
        hist = self.lseg.get_history(
            rics=rics, fields=["BID", "ASK", "TRDPRC_1"],
            interval="daily", start=start.isoformat(), end=end.isoformat(),
        )
        return {"ccy": ccy, "rics": rics, "history": hist}


def _num(x) -> Optional[float]:
    if x is None: return None
    try:
        import pandas as pd
        if pd.isna(x): return None
    except (TypeError, ValueError):
        pass
    try:
        v = float(x)
        if v != v: return None  # NaN
        return v
    except (TypeError, ValueError):
        return None


def _safe_put(q: asyncio.Queue, msg):
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        # drop oldest
        try: q.get_nowait()
        except Exception: pass
        try: q.put_nowait(msg)
        except Exception: pass
