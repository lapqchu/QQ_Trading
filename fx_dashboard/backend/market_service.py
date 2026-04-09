"""
Market data service — orchestrates snapshots + streaming for the FX dashboard.

KEY DESIGN: The market trades two components — SPOT and SWAP POINTS.
We fetch swap points RICs (e.g. TWD1MNDF=) as the primary data source,
NOT outright RICs. Outrights are derived: outright = spot + points/PF.

This ensures bid/ask spreads on swap points are accurate (market-traded
widths) rather than artificially wide from crossing two outright prices.

Channels:
  • spot      → every tick
  • forwards  → every 15s (debounced per RIC)
  • brokers   → every tick (broker monitor)
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import Dict, List, Any, Callable, Optional, Set
from dataclasses import dataclass, field

from lseg_client import LsegClient
from ric_config import (
    CURRENCIES, SOFR_RICS, CurrencyConfig, FUNDING_TENORS,
    all_swap_points_rics, all_outright_rics, all_broker_rics, all_funding_rics,
)

log = logging.getLogger(__name__)

FIELDS_QUOTE = ["BID", "ASK", "PRIMACT_1", "SEC_ACT_1", "TRDPRC_1", "HST_CLOSE", "GEN_VAL1", "TIMACT"]
THROTTLE_FORWARD_SEC = 15.0


@dataclass
class Quote:
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    ts: Optional[float] = None

    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2
        return self.last  # fallback to last if no bid/ask


class MarketService:
    def __init__(self, lseg: LsegClient):
        self.lseg = lseg
        self._quotes: Dict[str, Quote] = {}
        self._last_fwd_emit: Dict[str, float] = {}
        self._subscribers: Dict[str, Set[asyncio.Queue]] = {
            "spot": set(), "forwards": set(), "brokers": set(),
        }
        self._active_ccy: Optional[str] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._tick_counts: Dict[str, int] = {}  # diagnostic counters

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    # ────────────────── snapshot ──────────────────
    def build_snapshot(self, ccy: str) -> Dict[str, Any]:
        """Pull a one-shot snapshot for a currency.
        Fetches SWAP POINTS (primary) + spot + SOFR + IPA for non-anchor tenors."""
        cfg = CURRENCIES[ccy]

        # Build RIC list: spot + swap points + SOFR + funding (deliverables) + brokers
        swap_pts_rics = all_swap_points_rics(ccy)  # includes spot
        sofr_rics = list(SOFR_RICS.values())
        funding_rics = all_funding_rics(ccy)
        broker_rics = all_broker_rics(ccy)  # all 4 contributors × anchor tenors
        all_rics = swap_pts_rics + sofr_rics + funding_rics + broker_rics
        # For NDF: also fetch 1M outright (ticks frequently, used to derive implied spot)
        ndf_1m_outright_ric = None
        if cfg.kind == "NDF":
            ndf_1m_outright_ric = cfg.outright_ric(1)  # e.g. TWD1MNDFOR=
            if ndf_1m_outright_ric not in all_rics:
                all_rics.append(ndf_1m_outright_ric)

        log.info("Snapshot for %s: %d RICs (%d swap, %d broker, %d sofr, %d funding)",
                 ccy, len(all_rics), len(swap_pts_rics), len(broker_rics),
                 len(sofr_rics), len(funding_rics))

        # T (current) — live snapshot
        data_t = self.lseg.get_snapshot(all_rics, FIELDS_QUOTE)
        now = time.time()
        for ric, fields in data_t.items():
            # Use _first: pick first non-None value (do NOT use `or` — 0.0 is valid data)
            bid = _num(fields.get("BID"))
            if bid is None:
                bid = _num(fields.get("PRIMACT_1"))
            ask = _num(fields.get("ASK"))
            if ask is None:
                ask = _num(fields.get("SEC_ACT_1"))
            last = _num(fields.get("TRDPRC_1"))
            if last is None:
                last = _num(fields.get("HST_CLOSE"))
            if last is None:
                last = _num(fields.get("GEN_VAL1"))
            q = Quote(bid=bid, ask=ask, last=last, ts=now)
            self._quotes[ric] = q

        # T1 (previous close) — from daily history
        t1_quotes: Dict[str, Quote] = {}
        try:
            hist = self.lseg.get_history(
                rics=all_rics, fields=["BID", "ASK", "TRDPRC_1"],
                interval="daily", count=2,
            )
            for ric, bars in hist.items():
                if not bars:
                    continue
                bar = bars[-1] if len(bars) == 1 else bars[-2]
                t1_quotes[ric] = Quote(
                    bid=_num(bar.get("BID")), ask=_num(bar.get("ASK")),
                    last=_num(bar.get("TRDPRC_1")), ts=None,
                )
        except Exception as e:
            log.warning("T1 fetch failed: %s", e)

        # IPA enrichment: get Workspace-computed values for non-anchor display tenors
        # This covers weekly tenors and any month that isn't a direct RIC anchor
        ipa_data = self._fetch_ipa_tenors(cfg)

        return self._serialize_snapshot(cfg, t1_quotes, ipa_data)

    def _fetch_ipa_tenors(self, cfg: CurrencyConfig) -> Dict[str, Any]:
        """
        Call Workspace IPA for non-anchor tenors.

        Returns dict: { tenor_str: {fwdPoints, fwdRate, impliedYield, days, fixDate, valueDate, ...} }
        """
        anchor_set = set(cfg.anchor_tenors_m)
        ipa_tenors = []

        # Weekly tenors: 1W, 2W, 3W
        ipa_tenors.extend(["1W", "2W", "3W"])

        # Non-anchor monthly tenors up to max display
        for m in range(1, cfg.max_display_m + 1):
            if m not in anchor_set:
                if m < 12:
                    ipa_tenors.append(f"{m}M")
                elif m == 12:
                    ipa_tenors.append("1Y")
                elif m == 18:
                    ipa_tenors.append("18M")
                elif m == 24:
                    ipa_tenors.append("2Y")
                else:
                    ipa_tenors.append(f"{m}M")

        # Also get IPA for anchor tenors — for fix/value dates and cross-check
        for m in cfg.anchor_tenors_m:
            if m < 12:
                ipa_tenors.append(f"{m}M")
            elif m == 12:
                ipa_tenors.append("1Y")
            elif m == 18:
                ipa_tenors.append("18M")
            elif m == 24:
                ipa_tenors.append("2Y")

        if not ipa_tenors:
            return {}

        try:
            log.info("IPA batch for %s: %s", cfg.pair, ipa_tenors)
            results = self.lseg.calc_fx_forward_batch(cfg.pair, ipa_tenors)
            ipa_out = {}
            for tenor, data in results.items():
                if data:
                    ipa_out[tenor] = data
            log.info("IPA returned data for %d/%d tenors on %s", len(ipa_out), len(ipa_tenors), cfg.pair)
            return ipa_out
        except Exception as e:
            log.warning("IPA batch for %s failed (non-anchor tenors will use interpolation): %s", cfg.pair, e)
            return {}

    def _serialize_snapshot(self, cfg: CurrencyConfig, t1_quotes: Optional[Dict[str, Quote]] = None, ipa_data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Package cached quotes into a dashboard-friendly structure.

        KEY: For each tenor, we send swap points bid/ask directly from the RIC.
        The frontend uses these as the primary anchor for all calculations.
        Outrights are computed: outright = spot + points / pip_factor.

        IPA data is included for non-anchor tenors and for fix/value dates on all tenors.
        The frontend should prefer IPA values over its own interpolation.
        """
        t1 = t1_quotes or {}
        ipa = ipa_data or {}

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

        # Swap points per tenor (PRIMARY data)
        tenors = {}
        for m in cfg.anchor_tenors_m:
            ric = cfg.swap_points_ric(m)
            days_approx = _days_for_tenor(m)
            pts_data_t = _ser(ric, "T")
            pts_data_t1 = _ser(ric, "T1")

            # Check if we got meaningful data
            has_data = bool(
                pts_data_t["bid"] is not None or
                pts_data_t["ask"] is not None or
                pts_data_t["last"] is not None
            )

            tenors[m] = {
                "ric": ric,
                "days": days_approx,
                "T": pts_data_t,
                "T1": pts_data_t1,
                "hasData": has_data,
            }

        # SOFR curve
        sofr = {}
        for m, ric in SOFR_RICS.items():
            sofr[m] = {"ric": ric, "T": _ser(ric, "T"), "T1": _ser(ric, "T1")}

        # Funding tenors (deliverables only: ON, TN, SN)
        funding = {}
        if cfg.kind == "DELIVERABLE":
            for tenor in FUNDING_TENORS:
                ric = cfg.funding_ric(tenor)
                if ric:
                    funding[tenor] = {"ric": ric, "T": _ser(ric, "T"), "T1": _ser(ric, "T1")}

        # NDF 1M outright: used to derive implied spot (ticks frequently on LSEG)
        ndf_1m_out = None
        ndf_1m_out_ric = None
        if cfg.kind == "NDF":
            ndf_1m_out_ric = cfg.outright_ric(1)
            ndf_1m_out = {"ric": ndf_1m_out_ric, "T": _ser(ndf_1m_out_ric, "T"), "T1": _ser(ndf_1m_out_ric, "T1")}

        # Broker quotes: { contrib: { tenor_m: { T: {bid,ask,mid,...}, T1: {...} }, ... } }
        from ric_config import BROKER_CONTRIBUTORS
        brokers = {}
        for contrib in BROKER_CONTRIBUTORS:
            contrib_data = {}
            for m in cfg.anchor_tenors_m:
                bric = cfg.broker_ric(m, contrib)
                bt = _ser(bric, "T")
                bt1 = _ser(bric, "T1")
                has_data = bt["bid"] is not None or bt["ask"] is not None or bt["last"] is not None
                if has_data:
                    contrib_data[m] = {"ric": bric, "T": bt, "T1": bt1}
            if contrib_data:
                brokers[contrib] = contrib_data

        # Broker fallback: for anchor tenors where composite has no data,
        # try to fill from first available broker source
        for m in cfg.anchor_tenors_m:
            if not tenors[m]["hasData"]:
                for contrib in BROKER_CONTRIBUTORS:
                    contrib_m = brokers.get(contrib, {}).get(m)
                    if contrib_m:
                        log.info("Fallback: %s %dM composite empty, using %s",
                                 cfg.code, m, contrib)
                        tenors[m]["T"] = contrib_m["T"]
                        tenors[m]["T1"] = contrib_m.get("T1", tenors[m]["T1"])
                        tenors[m]["hasData"] = True
                        tenors[m]["ric"] = contrib_m["ric"]
                        tenors[m]["fallbackSource"] = contrib
                        break

        return {
            "ccy": cfg.code, "pair": cfg.pair, "kind": cfg.kind,
            "pipFactor": cfg.pip_factor, "outrightDp": cfg.outright_dp, "pipDp": cfg.pip_dp,
            "ptsInOutright": cfg.pts_in_outright,
            "tenorsM": cfg.anchor_tenors_m, "anchorTenorsM": cfg.anchor_tenors_m,
            "maxDisplayM": cfg.max_display_m,
            "spreadPack": cfg.spread_pack,
            "weeklyTenors": [0.25, 0.5, 0.75],
            "displayTenors": cfg.display_tenors,
            # KEY: dataType tells frontend these are swap points, not outrights
            "dataType": "swapPoints",
            "spot": {"ric": cfg.spot_ric, "T": spot_t, "T1": spot_t1},
            # NDF 1M outright — frontend uses this to derive implied spot for NDF pairs
            "ndf1mOutright": ndf_1m_out,
            "tenors": tenors,
            "sofr": sofr,
            "funding": funding,
            # Broker quotes by contributor
            "brokers": brokers,
            # IPA-computed values for non-anchor tenors and dates for all tenors.
            # Frontend should prefer these over its own interpolation.
            # Keys are tenor strings: "1W", "2W", "3W", "4M", "5M", etc.
            "ipa": ipa,
        }

    # ────────────────── live streaming ──────────────────
    def start_streams(self, ccy: str):
        """Open three streams for active currency."""
        self._active_ccy = ccy
        self._tick_counts = {"spot": 0, "fwd": 0, "brk": 0}  # reset counters
        cfg = CURRENCIES[ccy]

        # Spot — tick granularity
        # For NDF: also stream 1M outright (ticks frequently, used to derive implied spot)
        spot_rics = [cfg.spot_ric]
        if cfg.kind == "NDF":
            spot_rics.append(cfg.outright_ric(1))  # e.g. TWD1MNDFOR=
        log.info("Starting SPOT stream for %s: %s", ccy, spot_rics)
        self.lseg.subscribe(
            tag=f"spot-{ccy}",
            rics=spot_rics,
            fields=FIELDS_QUOTE,
            on_update=lambda ric, f: self._on_spot_tick(ric, f),
        )

        # Forwards (swap points) — tick but throttled to 15s per RIC
        fwd_rics = [cfg.swap_points_ric(m) for m in cfg.anchor_tenors_m]
        log.info("Starting FWD stream for %s: %s", ccy, fwd_rics)
        self.lseg.subscribe(
            tag=f"fwd-{ccy}",
            rics=fwd_rics,
            fields=FIELDS_QUOTE,
            on_update=lambda ric, f: self._on_fwd_tick(ric, f),
        )

        # Brokers — tick
        br_rics = all_broker_rics(ccy)
        log.info("Starting BRK stream for %s: %d broker RICs", ccy, len(br_rics))
        if br_rics:
            self.lseg.subscribe(
                tag=f"brk-{ccy}",
                rics=br_rics,
                fields=FIELDS_QUOTE,
                on_update=lambda ric, f: self._on_broker_tick(ric, f),
            )

    def stop_streams(self, ccy: Optional[str] = None):
        c = ccy or self._active_ccy
        if not c:
            return
        for prefix in ("spot", "fwd", "brk"):
            self.lseg.unsubscribe(f"{prefix}-{c}")

    def _on_spot_tick(self, ric: str, updates: Dict[str, Any]):
        self._tick_counts["spot"] = self._tick_counts.get("spot", 0) + 1
        q = self._apply_update(ric, updates)
        if self._tick_counts["spot"] <= 10:
            log.info("SPOT tick #%d: %s bid=%s ask=%s mid=%s",
                     self._tick_counts["spot"], ric, q.bid, q.ask, q.mid())
        self._fanout("spot", {"ric": ric, "bid": q.bid, "ask": q.ask, "mid": q.mid(), "ts": q.ts})

    def _on_fwd_tick(self, ric: str, updates: Dict[str, Any]):
        self._tick_counts["fwd"] = self._tick_counts.get("fwd", 0) + 1
        q = self._apply_update(ric, updates)
        if self._tick_counts["fwd"] <= 20:
            log.info("FWD tick #%d: %s bid=%s ask=%s mid=%s",
                     self._tick_counts["fwd"], ric, q.bid, q.ask, q.mid())
        now = time.time()
        last = self._last_fwd_emit.get(ric, 0.0)
        if now - last >= THROTTLE_FORWARD_SEC:
            self._last_fwd_emit[ric] = now
            log.info("FWD emit: %s bid=%s ask=%s mid=%s", ric, q.bid, q.ask, q.mid())
            self._fanout("forwards", {"ric": ric, "bid": q.bid, "ask": q.ask, "mid": q.mid(), "ts": q.ts})

    def _on_broker_tick(self, ric: str, updates: Dict[str, Any]):
        self._tick_counts["brk"] = self._tick_counts.get("brk", 0) + 1
        q = self._apply_update(ric, updates)
        if self._tick_counts["brk"] <= 10:
            log.info("BRK tick #%d: %s bid=%s ask=%s mid=%s",
                     self._tick_counts["brk"], ric, q.bid, q.ask, q.mid())
        self._fanout("brokers", {"ric": ric, "bid": q.bid, "ask": q.ask, "mid": q.mid(), "ts": q.ts})

    def _apply_update(self, ric: str, updates: Dict[str, Any]) -> Quote:
        q = self._quotes.get(ric)
        if q is None:
            q = Quote()
        # Process updates — dict or pandas-like object
        try:
            upd = dict(updates) if not isinstance(updates, dict) else updates
        except Exception:
            upd = updates
        if "BID" in upd:
            q.bid = _num(upd["BID"])
        if "ASK" in upd:
            q.ask = _num(upd["ASK"])
        if "TRDPRC_1" in upd:
            q.last = _num(upd["TRDPRC_1"])
        if "PRIMACT_1" in upd and q.bid is None:
            q.bid = _num(upd["PRIMACT_1"])
        if "SEC_ACT_1" in upd and q.ask is None:
            q.ask = _num(upd["SEC_ACT_1"])
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
        if s and q in s:
            s.discard(q)

    def _fanout(self, channel: str, msg: Dict[str, Any]):
        if not self._loop:
            return
        subs = list(self._subscribers.get(channel, set()))
        for q in subs:
            try:
                self._loop.call_soon_threadsafe(_safe_put, q, msg)
            except Exception as e:
                log.warning("fanout %s: %s", channel, e)

    # ────────────────── history (on demand) ──────────────────
    def get_history(self, ccy: str, days: int = 60, contributor: str = None) -> Dict[str, Any]:
        """Historical daily bars — swap points for NDF, spot+points for deliverable.
        If contributor is provided (e.g. 'TRDS'), use broker-specific RICs instead of composite."""
        cfg = CURRENCIES[ccy]
        if contributor:
            # Broker-specific RICs: e.g. TWD6MNDF=TRDS
            rics = [cfg.spot_ric]
            rics.extend(cfg.broker_ric(m, contributor) for m in cfg.anchor_tenors_m)
        else:
            # Composite RICs (default)
            rics = all_swap_points_rics(ccy)

        from datetime import datetime, timedelta
        end = datetime.utcnow().date()
        start = end - timedelta(days=days + 20)  # padding for non-trading days
        hist = self.lseg.get_history(
            rics=rics, fields=["BID", "ASK", "TRDPRC_1"],
            interval="daily", start=start.isoformat(), end=end.isoformat(),
        )
        return {"ccy": ccy, "pair": cfg.pair, "kind": cfg.kind, "rics": rics, "history": hist,
                "contributor": contributor}


def _days_for_tenor(m: int) -> int:
    """Approximate days for a tenor in months."""
    return {1: 30, 2: 61, 3: 91, 6: 182, 9: 273, 12: 365, 18: 547, 24: 730}.get(m, m * 30)


def _num(x) -> Optional[float]:
    if x is None:
        return None
    try:
        import pandas as pd
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    try:
        v = float(x)
        if v != v:  # NaN
            return None
        return v
    except (TypeError, ValueError):
        return None


def _safe_put(q: asyncio.Queue, msg):
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except Exception:
            pass
        try:
            q.put_nowait(msg)
        except Exception:
            pass
