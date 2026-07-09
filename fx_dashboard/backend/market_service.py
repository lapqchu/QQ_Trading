"""
Market data service — orchestrates snapshots + streaming for the FX dashboard.

KEY INVARIANTS
  1. For each tenor we publish an explicit per-source dict ("sources"):
     { "composite": {...}, "FMD": {...}, "BGCP": {...}, ... }
     Each entry carries its own bid/ask/mid, TIMACT ts, ageSec, freshness
     bucket ('fresh' | 'stale' | 'very_stale'), and valueMode ('pips'|'outright').
  2. No silent fallbacks. Frontend decides how to aggregate — we don't fill
     composite from broker or vice versa.
  3. 18M NDF tenors: composite slot is absent; frontend shows only the
     configured broker fallbacks (e.g. FMD).
  4. NGN (derive_from_outrights): per-broker "sources" entries carry
     {outright_bid, outright_ask} AND derived {bid, ask} in market points
     convention. Frontend can display either.
  5. Funding tenors (ON/TN/SN) publish the same per-source dict shape.

STALENESS
  fresh      < 10 min
  stale      10 min – 1 h
  very_stale > 1 h
"""

from __future__ import annotations
import asyncio
import logging
import time
from datetime import datetime, date, timedelta
from typing import Dict, List, Any, Optional, Set, Tuple
from dataclasses import dataclass

from lseg_client import LsegClient
from turns import generate_turns, turn_types_for
from ric_config import (
    CURRENCIES, SOFR_RICS, FUNDING_TENORS, BROKER_META,
    CurrencyConfig,
    all_swap_points_rics, all_outright_rics, all_broker_rics, all_funding_rics,
    all_extended_rics, all_weekly_rics,
)


def _sofr_ric_for_tenor(tenor: Optional[str]) -> Optional[str]:
    """Map a tenor code (e.g. '1M', '3M', '1Y') to the nearest SOFR RIC."""
    if not tenor:
        return None
    t = tenor.upper().strip()
    m = None
    try:
        if t.endswith("Y"):
            m = int(t[:-1]) * 12
        elif t.endswith("M"):
            m = int(t[:-1])
        elif t.endswith("W"):
            m = max(1, int(t[:-1]) // 4)
    except (TypeError, ValueError):
        return None
    if m is None:
        return None
    # pick nearest available key in SOFR_RICS
    keys = sorted(SOFR_RICS.keys())
    nearest = min(keys, key=lambda k: abs(k - m))
    return SOFR_RICS[nearest]

log = logging.getLogger(__name__)

FIELDS_QUOTE = ["BID", "ASK", "PRIMACT_1", "SEC_ACT_1", "TRDPRC_1",
                "HST_CLOSE", "GEN_VAL1", "TIMACT"]

THROTTLE_FORWARD_SEC = 15.0
FRESH_SEC = 10 * 60       # < 10 min
STALE_SEC = 60 * 60       # < 1 h    (above → very_stale)


# ─────────────────────────────────────────────────────────────
# QUOTE STORE
# ─────────────────────────────────────────────────────────────
@dataclass
class Quote:
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    ts: Optional[float] = None          # our receive-time (unix)
    timact: Optional[str] = None        # LSEG TIMACT field (HH:MM:SS source clock)
    timact_ts: Optional[float] = None   # TIMACT converted to unix (today's date)

    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2
        return self.last


def _parse_timact(timact: Any) -> Optional[float]:
    """TIMACT is HH:MM:SS string on source's clock. Convert to today's unix ts (UTC)."""
    if timact is None:
        return None
    try:
        import pandas as pd
        if pd.isna(timact):
            return None
    except (TypeError, ValueError):
        pass
    s = str(timact).strip()
    if not s or s in ("<NA>", "NaT", "nan", "None"):
        return None
    try:
        parts = s.split(":")
        if len(parts) < 2:
            return None
        h, m = int(parts[0]), int(parts[1])
        sec = int(parts[2]) if len(parts) > 2 else 0
        today = datetime.utcnow().date()
        dt = datetime(today.year, today.month, today.day, h, m, sec)
        return dt.timestamp()
    except Exception:
        return None


def _freshness(ts: Optional[float]) -> str:
    if ts is None:
        return "unknown"
    age = time.time() - ts
    if age < FRESH_SEC:
        return "fresh"
    if age < STALE_SEC:
        return "stale"
    return "very_stale"


# ─────────────────────────────────────────────────────────────
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
        self._tick_counts: Dict[str, int] = {}
        # IPA day-cache: Workspace's IPA endpoint serializes concurrent calls
        # (~1s each), and fix/value dates don't change intraday — cache per
        # (pair, date_str) and invalidate at midnight UTC.
        self._ipa_cache: Dict[str, Any] = {}        # key: f"{pair}@{date}"
        self._tomfix_cache: Dict[str, Any] = {}
        self._t1_cache: Dict[str, Quote] = {}       # key: f"{ric}@{date}"
        # Auto-detected per-source value_mode overrides ({ccy: {source_name: mode}}).
        # Populated each time build_snapshot runs auto-detect; consumed by
        # get_history when tagging RIC metadata so historical bars are
        # normalized using the same mode the live snapshot uses.
        self._value_mode_overrides: Dict[str, Dict[str, str]] = {}

    def set_loop(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop

    # ────────────────── snapshot ──────────────────
    def build_snapshot(self, ccy: str) -> Dict[str, Any]:
        cfg = CURRENCIES[ccy]

        composite_rics = all_swap_points_rics(ccy)            # includes spot
        outright_rics = all_outright_rics(ccy)                # NGN MBGL outrights
        broker_rics = all_broker_rics(ccy)                    # swap pts per broker
        sofr_rics = list(SOFR_RICS.values())
        funding_rics = all_funding_rics(ccy)                  # deliverables only
        extended_rics = all_extended_rics(ccy)                # 4M/5M/7M/.../21M
        weekly_rics = all_weekly_rics(ccy)                    # SW / 2W / 3W

        # Also fetch 1M NDF outright for implied-spot derivation
        ndf_1m_out_ric = None
        ndf_1m_out_broker_rics: List[str] = []  # Issue 2: BGCP+FMD avg
        if cfg.kind == "NDF" and not cfg.derive_from_outrights:
            ndf_1m_out_ric = f"{cfg.code}1MNDFOR="
            # Fetch per-broker 1M outright RICs for BGCP/FMD avg
            for bk in ("BGCP", "FMD"):
                ndf_1m_out_broker_rics.append(f"{cfg.code}1MNDFOR={bk}")
        extra = ([ndf_1m_out_ric] if ndf_1m_out_ric else []) + ndf_1m_out_broker_rics

        all_rics = list({*composite_rics, *outright_rics, *broker_rics,
                         *sofr_rics, *funding_rics, *extended_rics,
                         *weekly_rics, *extra})

        log.info("Snapshot %s: %d RICs (comp=%d brk=%d out=%d fund=%d)",
                 ccy, len(all_rics), len(composite_rics), len(broker_rics),
                 len(outright_rics), len(funding_rics))

        # T snapshot
        data_t = self.lseg.get_snapshot(all_rics, FIELDS_QUOTE)
        now = time.time()
        for ric, fields in data_t.items():
            bid = _num(fields.get("BID"))  or _num(fields.get("PRIMACT_1"))
            ask = _num(fields.get("ASK"))  or _num(fields.get("SEC_ACT_1"))
            last = _num(fields.get("TRDPRC_1")) or _num(fields.get("HST_CLOSE")) or _num(fields.get("GEN_VAL1"))
            timact_raw = fields.get("TIMACT")
            timact_ts = _parse_timact(timact_raw)
            timact_str = None
            if timact_ts is not None:
                timact_str = str(timact_raw)
            self._quotes[ric] = Quote(bid=bid, ask=ask, last=last, ts=now,
                                      timact=timact_str, timact_ts=timact_ts)

        # T1 MINIMAL on cold snapshot: spot + composite swap pts + SOFR only.
        # Broker/outright/funding T-1 is fetched lazily via /api/t1-backfill
        # (when user ticks a new broker) or folded in from the History response
        # (penultimate daily bar contains T-1 for free). Cached per (ric, date).
        t1_rics = (
            [cfg.spot_ric]
            + [r for r in composite_rics if r != cfg.spot_ric]
            + sofr_rics
        )
        t1_rics = list(dict.fromkeys(t1_rics))
        today_iso = date.today().isoformat()
        t1: Dict[str, Quote] = {}
        uncached: List[str] = []
        for r in t1_rics:
            cached = self._t1_cache.get(f"{r}@{today_iso}")
            if cached is not None:
                t1[r] = cached
            else:
                uncached.append(r)
        # Run T1 history + IPA tenors + tomfix concurrently — they hit
        # different Workspace endpoints (history vs IPA) so they overlap.
        from concurrent.futures import ThreadPoolExecutor
        def _do_t1():
            if not uncached:
                return {}
            CHUNK = 20
            chunks = [uncached[i:i+CHUNK] for i in range(0, len(uncached), CHUNK)]
            def _fetch(chunk):
                try:
                    return self.lseg.get_history(chunk, ["BID", "ASK", "TRDPRC_1"],
                                                 interval="daily", count=2)
                except Exception as e:
                    log.warning("T1 chunk fetch failed (%d RICs): %s", len(chunk), e)
                    return {}
            merged: Dict[str, Any] = {}
            with ThreadPoolExecutor(max_workers=min(8, len(chunks))) as ex:
                for hist in ex.map(_fetch, chunks):
                    merged.update(hist)
            return merged

        with ThreadPoolExecutor(max_workers=3) as ex:
            fut_t1 = ex.submit(_do_t1)
            fut_ipa = ex.submit(self._fetch_ipa_tenors, cfg)
            fut_tom = ex.submit(self._fetch_tomfix_cached, cfg)
            hist_merged = fut_t1.result()
            ipa_data = fut_ipa.result()
            tomfix_pl = fut_tom.result()

        for ric, bars in hist_merged.items():
            if not bars:
                continue
            bar = bars[-1] if len(bars) == 1 else bars[-2]
            q = Quote(bid=_num(bar.get("BID")), ask=_num(bar.get("ASK")),
                      last=_num(bar.get("TRDPRC_1")))
            t1[ric] = q
            self._t1_cache[f"{ric}@{today_iso}"] = q
        log.info("Snapshot %s T1 history: %d RICs (cached=%d, fetched=%d)",
                 ccy, len(t1_rics), len(t1_rics) - len(uncached), len(uncached))

        return self._serialize(cfg, t1, ipa_data, ndf_1m_out_ric, tomfix_pl,
                               ndf_1m_out_broker_rics=ndf_1m_out_broker_rics)

    def backfill_t1(self, rics: List[str]) -> Dict[str, Any]:
        """Lazy T-1 fetch for a specific set of RICs. Uses the per-(ric,date)
        cache so repeat calls are instant. Returns {ric: {bid,ask,last} | null}."""
        today_iso = date.today().isoformat()
        out: Dict[str, Any] = {}
        uncached: List[str] = []
        for r in rics:
            hit = self._t1_cache.get(f"{r}@{today_iso}")
            if hit is not None:
                out[r] = {"bid": hit.bid, "ask": hit.ask, "last": hit.last}
            else:
                uncached.append(r)
        if uncached:
            try:
                hist = self.lseg.get_history(uncached, ["BID", "ASK", "TRDPRC_1"],
                                             interval="daily", count=2)
            except Exception as e:
                log.warning("backfill_t1 history failed: %s", e)
                hist = {}
            for ric, bars in hist.items():
                if not bars:
                    continue
                bar = bars[-1] if len(bars) == 1 else bars[-2]
                q = Quote(bid=_num(bar.get("BID")), ask=_num(bar.get("ASK")),
                          last=_num(bar.get("TRDPRC_1")))
                self._t1_cache[f"{ric}@{today_iso}"] = q
                out[ric] = {"bid": q.bid, "ask": q.ask, "last": q.last}
        for r in rics:
            out.setdefault(r, None)
        return out

    def absorb_history_as_t1(self, hist: Dict[str, List[Dict[str, Any]]]):
        """Opportunistic: when a history response passes through, its penultimate
        daily bar IS today's T-1. Folded into the T-1 cache so later IY D/D
        lookups don't require a second call."""
        today_iso = date.today().isoformat()
        for ric, bars in (hist or {}).items():
            if not bars or len(bars) < 1:
                continue
            bar = bars[-1] if len(bars) == 1 else bars[-2]
            q = Quote(bid=_num(bar.get("BID")), ask=_num(bar.get("ASK")),
                      last=_num(bar.get("TRDPRC_1")))
            self._t1_cache.setdefault(f"{ric}@{today_iso}", q)

    def _fetch_ipa_tenors(self, cfg: CurrencyConfig) -> Dict[str, Any]:
        """
        IPA enrichment for anchor tenors + 1W only. Non-anchor tenors
        (4M/5M/7M/8M/10M/11M/13-17M/19-23M) are interpolated client-side
        from anchor days — avoids ~20 extra IPA calls per snapshot.
        Result is cached per (pair, today) — dates don't change intraday.
        """
        cache_key = f"{cfg.pair}@{date.today().isoformat()}"
        if cache_key in self._ipa_cache:
            return self._ipa_cache[cache_key]

        tenors = ["1W"] + [_ipa_tenor_code(m) for m in cfg.anchor_tenors_m]
        # Deliverables: also resolve ON/TN/SN value dates so funding-pack rows
        # have proper startDate/endDate/days without client-side guessing.
        if cfg.kind == "DELIVERABLE":
            tenors += ["ON", "TN", "SN"]
        try:
            out = {t: d for t, d in self.lseg.calc_fx_forward_batch(cfg.pair, tenors, kind=cfg.kind).items() if d}
        except Exception as e:
            log.warning("IPA batch %s failed: %s", cfg.pair, e)
            out = {}
        self._ipa_cache[cache_key] = out
        return out

    def _fetch_tomfix_cached(self, cfg: CurrencyConfig):
        if cfg.kind != "NDF":
            return None
        cache_key = f"{cfg.pair}@{date.today().isoformat()}"
        if cache_key in self._tomfix_cache:
            return self._tomfix_cache[cache_key]
        try:
            res = self.lseg.calc_tomfix_plus_1bd(cfg.pair, kind=cfg.kind)
        except Exception as e:
            log.info("calc_tomfix_plus_1bd %s failed: %s", cfg.pair, e)
            res = None
        self._tomfix_cache[cache_key] = res
        return res

    # ────────────────── serialise ──────────────────
    def _serialize(self, cfg: CurrencyConfig, t1: Dict[str, Quote],
                   ipa: Dict[str, Any], ndf_1m_out_ric: Optional[str],
                   tomfix_pl: Optional[Dict[str, Any]] = None,
                   ndf_1m_out_broker_rics: Optional[List[str]] = None) -> Dict[str, Any]:
        spot_t = self._ser_ric(cfg.spot_ric, "T")
        spot_t1 = self._ser_ric(cfg.spot_ric, "T", t1=t1)

        ndf_1m_out = None
        if ndf_1m_out_ric:
            comp_t = self._ser_ric(ndf_1m_out_ric, "T")
            comp_t1 = self._ser_ric(ndf_1m_out_ric, "T", t1=t1)
            # Issue 2: compute avg of BGCP + FMD outright RICs
            broker_sources = {}
            avg_bids, avg_asks, avg_mids = [], [], []
            avg_bids_t1, avg_asks_t1, avg_mids_t1 = [], [], []
            for bric in (ndf_1m_out_broker_rics or []):
                bk_suffix = bric.rsplit("=", 1)[-1] if "=" in bric else "composite"
                bt = self._ser_ric(bric, "T")
                bt1 = self._ser_ric(bric, "T", t1=t1)
                has_data = bt.get("bid") is not None or bt.get("ask") is not None or bt.get("mid") is not None
                broker_sources[bk_suffix] = {"ric": bric, "T": bt, "T1": bt1, "hasData": has_data}
                if has_data:
                    if bt.get("bid") is not None: avg_bids.append(bt["bid"])
                    if bt.get("ask") is not None: avg_asks.append(bt["ask"])
                    m = bt.get("mid")
                    if m is None and bt.get("bid") is not None and bt.get("ask") is not None:
                        m = (bt["bid"] + bt["ask"]) / 2
                    if m is not None: avg_mids.append(m)
                    # T1
                    if bt1.get("bid") is not None: avg_bids_t1.append(bt1["bid"])
                    if bt1.get("ask") is not None: avg_asks_t1.append(bt1["ask"])
                    m1 = bt1.get("mid")
                    if m1 is None and bt1.get("bid") is not None and bt1.get("ask") is not None:
                        m1 = (bt1["bid"] + bt1["ask"]) / 2
                    if m1 is not None: avg_mids_t1.append(m1)
            def _avg(lst): return sum(lst) / len(lst) if lst else None
            # Use broker avg if available, else fall back to composite
            avg_t = {
                "bid": _avg(avg_bids), "ask": _avg(avg_asks), "mid": _avg(avg_mids),
            } if avg_mids else comp_t
            avg_t1 = {
                "bid": _avg(avg_bids_t1), "ask": _avg(avg_asks_t1), "mid": _avg(avg_mids_t1),
            } if avg_mids_t1 else comp_t1
            ndf_1m_out = {
                "ric": ndf_1m_out_ric,
                "T":  avg_t,
                "T1": avg_t1,
                "sources": {"composite": {"T": comp_t, "T1": comp_t1}, **broker_sources},
                "sourceLabel": "BGCP/FMD avg" if avg_mids else "composite",
            }

        # Per-tenor per-source bundle (pass IPA data so days reflect real calendar).
        # anchor tenors get full source list; extended tenors (non-anchor months
        # with broker/composite data) get a lighter bundle tagged hasAnchorRic=False.
        tenors: Dict[int, Any] = {}
        anchor_set = set(cfg.anchor_tenors_m)
        for m in cfg.anchor_tenors_m:
            b = self._tenor_bundle(cfg, m, t1, ipa)
            b["hasAnchorRic"] = True
            b["hasBrokerRic"] = "FMD" in cfg.brokers
            tenors[m] = b
        for m in cfg.extended_tenors_m:
            if m in anchor_set:
                continue
            b = self._extended_tenor_bundle(cfg, m, t1)
            b["hasAnchorRic"] = False
            b["hasBrokerRic"] = "FMD" in cfg.brokers
            tenors[m] = b

        # Weekly RICs block. NDF: SW only. DELIVERABLE: SW/2W/3W.
        weekly: Dict[str, Any] = {}
        for key, ric in cfg.weekly_rics().items():
            q = self._quotes.get(ric, Quote())
            ts = q.timact_ts or q.ts
            has = q.bid is not None or q.ask is not None or q.last is not None
            weekly[key] = {
                "ric": ric,
                "bid": q.bid, "ask": q.ask, "mid": q.mid(), "last": q.last,
                "ts": ts, "ageSec": _age(ts), "freshness": _freshness(ts),
                "timact": q.timact,
                "valueMode": cfg.value_mode,
                "hasData": has,
            }

        # Funding (deliverables)
        funding = {}
        funding_dates: Dict[str, Any] = {}
        if cfg.kind == "DELIVERABLE":
            for tfund in FUNDING_TENORS:
                funding[tfund] = self._funding_bundle(cfg, tfund, t1)
                # IPA-resolved dates for the funding tenor (start/end/days).
                ipa_entry = (ipa or {}).get(tfund) or {}
                if ipa_entry:
                    funding_dates[tfund] = {
                        "startDate": ipa_entry.get("startDate") or ipa_entry.get("valueDate"),
                        "endDate":   ipa_entry.get("endDate")   or ipa_entry.get("valueDate"),
                        "days":      ipa_entry.get("days"),
                    }

        # SOFR
        sofr = {m: {"ric": r, "T": self._ser_ric(r, "T"),
                    "T1": self._ser_ric(r, "T", t1=t1)}
                for m, r in SOFR_RICS.items()}

        # Broker meta (labels/groups) — only brokers configured for this ccy
        brokers_meta = {}
        for b in cfg.brokers:
            base = dict(BROKER_META.get(b, {"group": b, "label": b}))
            base["valueMode"] = cfg.value_mode_for(b)
            brokers_meta[b] = base

        snap = {
            "ccy": cfg.code, "pair": cfg.pair, "kind": cfg.kind,
            "pipFactor": cfg.pip_factor, "outrightDp": cfg.outright_dp, "pipDp": cfg.pip_dp,
            "valueMode": cfg.value_mode, "ptsInOutright": cfg.pts_in_outright,
            "deriveFromOutrights": cfg.derive_from_outrights,
            "tenorsM": cfg.anchor_tenors_m, "anchorTenorsM": cfg.anchor_tenors_m,
            "extendedTenorsM": cfg.extended_tenors_m,
            "weekly": weekly,
            "maxDisplayM": cfg.max_display_m,
            "spreadPack": cfg.spread_pack,
            "weeklyTenors": [0.25, 0.5, 0.75],
            "displayTenors": cfg.display_tenors,
            "dataType": "swapPoints",
            "spot": {"ric": cfg.spot_ric, "T": spot_t, "T1": spot_t1},
            "ndf1mOutright": ndf_1m_out,
            "tenors": tenors,
            "funding": funding,
            "fundingDates": funding_dates,
            "sofr": sofr,
            "brokers": [b for b in cfg.brokers],     # just the ordered list
            "brokersMeta": brokers_meta,
            "freshnessThresholdsSec": {"fresh": FRESH_SEC, "stale": STALE_SEC},
            "ipa": ipa,
            "tomfixPlus1bd": tomfix_pl,
            "turnTypes": turn_types_for(cfg),
            "turns": self._build_turns_payload(cfg, ipa),
        }
        # Auto-detect actual quote convention per-source and override if it
        # differs from cfg.value_mode_for(...). Some currencies' configs were
        # calibrated by inspection at one point in time; LSEG occasionally
        # changes how it quotes a given RIC (units, scale), and a stale config
        # silently produces F≈S → IY≈SOFR. Self-healing keeps the dashboard
        # correct without manual config updates per currency.
        try:
            self._auto_detect_value_modes(cfg, snap)
        except Exception as e:
            log.info("value_mode auto-detect failed for %s: %s", cfg.code, e)
        return snap

    # ───── value_mode auto-detect ─────
    def _auto_detect_value_modes(self, cfg: CurrencyConfig, snap: Dict[str, Any]) -> None:
        """
        Determine the actual quote convention each source is using and override
        snap.tenors[*].sources[*].valueMode + snap.valueMode in-place.

        Strategy:
          NDFs       use the separate 1M outright RIC (`{CCY}1MNDFOR=`) as
                     ground truth: expected_outright_diff = 1M_outright − spot.
                     For each source's 1M raw mid, ratio = raw / expected gives
                     ~1 (outright units) or ~pip_factor (pip units).
          Deliverables fall back to IPA's impliedYield: pick the value_mode
                     whose computed IY matches IPA most closely.

        Detection is per-source (composite vs broker can legitimately differ —
        MXN, for example) but the chosen mode is then propagated to ALL tenors
        of that source name (one currency uses one convention across tenors).

        If detection is ambiguous (no clear winner), keep cfg.value_mode_for —
        no false-positive override.
        """
        tenors = snap.get("tenors") or {}
        t1 = tenors.get(1) or tenors.get("1")
        if not t1 or not t1.get("sources"):
            return
        spot = (snap.get("spot") or {}).get("T") or {}
        spot_mid = spot.get("mid")
        if spot_mid is None:
            return
        PF = float(cfg.pip_factor)
        if PF <= 0:
            return

        # Reference outright diff (per-source raw → outright units).
        # NDF: 1M outright RIC. Deliverable: derive from IPA implied yield.
        if cfg.kind == "NDF":
            ndf_1m = snap.get("ndf1mOutright") or {}
            om = ((ndf_1m.get("T") or {}).get("mid"))
            if om is None or abs(om - spot_mid) < 1e-9:
                log.warning(
                    "value_mode auto-detect SKIPPED [%s]: NDF 1M outright ref %s unusable "
                    "(om=%s, spot=%s) — keeping config value_mode; IY will collapse to SOFR "
                    "if the live feed units differ from config",
                    cfg.code, ndf_1m.get("ric"), om, spot_mid)
                return
            expected_diff = om - spot_mid
            ref_label = f"NDF outright {ndf_1m.get('ric')}"
        else:
            ipa = snap.get("ipa") or {}
            ipa_1m = ipa.get("1M") or {}
            ipa_iy = ipa_1m.get("impliedYield")
            ipa_days = ipa_1m.get("days") or 30
            if ipa_iy is None:
                log.warning(
                    "value_mode auto-detect SKIPPED [%s]: no IPA impliedYield ref — "
                    "keeping config value_mode; IY may be mis-scaled", cfg.code)
                return
            sofr_block = (snap.get("sofr") or {}).get(1) or (snap.get("sofr") or {}).get("1")
            sofr_mid = (((sofr_block or {}).get("T") or {}).get("mid")
                        if sofr_block else None)
            if sofr_mid is None:
                log.warning(
                    "value_mode auto-detect SKIPPED [%s]: no SOFR ref — "
                    "keeping config value_mode; IY may be mis-scaled", cfg.code)
                return
            # Invert the IY formula to get the implied F → expected_diff = F − S.
            # F = S × (1 + ipa_iy/100 × d/360) / (1 + sofr/100 × d/360)
            num = 1.0 + (float(ipa_iy) / 100.0) * float(ipa_days) / 360.0
            den = 1.0 + (float(sofr_mid) / 100.0) * float(ipa_days) / 360.0
            if den == 0:
                return
            f_implied = spot_mid * num / den
            expected_diff = f_implied - spot_mid
            if abs(expected_diff) < 1e-9:
                return
            ref_label = f"IPA impliedYield={ipa_iy:.3f}%"

        # Detect per-source.
        TOL = 0.30  # 30% tolerance on the ratio match
        detected: Dict[str, str] = {}
        for name, s in (t1.get("sources") or {}).items():
            if not s or not s.get("hasData"):
                continue
            raw = s.get("mid")
            if raw is None:
                bid, ask = s.get("bid"), s.get("ask")
                if bid is None or ask is None:
                    continue
                raw = (bid + ask) / 2.0
            if abs(raw) < 1e-9:
                continue
            ratio = raw / expected_diff
            r_outright = abs(ratio - 1.0)
            r_pips = abs(ratio - PF) / PF
            current = cfg.value_mode_for(name)
            if r_outright < TOL and r_outright < r_pips:
                picked = "outright"
            elif r_pips < TOL and r_pips < r_outright:
                picked = "pips"
            else:
                # Ambiguous: neither ~1 (outright) nor ~PF (pips). Keep config,
                # but surface it — a silent skip here is how a mis-scaled feed
                # slips through and collapses IY onto SOFR.
                log.warning(
                    "value_mode AMBIGUOUS [%s/%s]: raw=%.6g expected_diff=%.6g ratio=%.3f "
                    "(neither ~1 nor ~PF=%g, TOL=%.2f) — keeping config '%s'; IY may be wrong",
                    cfg.code, name, raw, expected_diff, ratio, PF, TOL, current)
                continue
            if picked != current:
                log.warning("value_mode override [%s/%s]: %s → %s (raw=%.6g, expected_diff=%.6g, ratio=%.3f, ref=%s)",
                            cfg.code, name, current, picked, raw, expected_diff, ratio, ref_label)
            detected[name] = picked

        if not detected:
            # Empty the cache for this ccy if we previously had overrides.
            if cfg.code in self._value_mode_overrides:
                self._value_mode_overrides[cfg.code] = {}
            return

        # Cache for use by get_history (so the modal IY view normalizes
        # historical bars using the same mode the live snapshot uses).
        self._value_mode_overrides[cfg.code] = dict(detected)

        # Propagate to ALL tenors of each detected source name.
        for tbundle in tenors.values():
            sources = (tbundle or {}).get("sources") or {}
            for name, s in sources.items():
                if name in detected and s:
                    s["valueMode"] = detected[name]

        # Also patch funding bundles, weekly, and ndf1mOutright broker sources.
        for f in (snap.get("funding") or {}).values():
            for name, s in ((f or {}).get("sources") or {}).items():
                if name in detected and s:
                    s["valueMode"] = detected[name]
        for w in (snap.get("weekly") or {}).values():
            if w and w.get("hasData"):
                # weekly carries a single value_mode tag (no source name);
                # follow the composite override when available.
                comp = detected.get("composite")
                if comp:
                    w["valueMode"] = comp

        # Patch top-level snap.valueMode + brokersMeta to reflect detection so
        # the frontend valueModeForSource() resolver also sees the corrected
        # mode (used by the modal IY view, etc.).
        comp = detected.get("composite")
        if comp and comp != snap.get("valueMode"):
            snap.setdefault("valueModeOverridden", {})["composite"] = {
                "config": snap.get("valueMode"), "detected": comp,
            }
            snap["valueMode"] = comp
        bm = snap.get("brokersMeta") or {}
        for name, mode in detected.items():
            if name in bm:
                if bm[name].get("valueMode") != mode:
                    snap.setdefault("valueModeOverridden", {})[name] = {
                        "config": bm[name].get("valueMode"), "detected": mode,
                    }
                bm[name]["valueMode"] = mode

    # ───── turn calendar payload ─────
    def _build_turns_payload(self, cfg: CurrencyConfig,
                             ipa: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Generate turn dates for the next 24M anchored to spot.
        spot_date is derived from the IPA spot bundle when available; otherwise
        we approximate as today + 2 calendar days. Each turn date returned is
        the post-boundary VALUE date (first biz day at-or-after the new period
        + T+2 spot offset) — the first FX swap VD that holds USD across the
        calendar boundary. See turns.py for the full derivation."""
        spot_iso = None
        if ipa:
            for key in ("spot", "SP", "Spot"):
                v = ipa.get(key) if isinstance(ipa, dict) else None
                if v and isinstance(v, dict):
                    spot_iso = v.get("valueDate") or v.get("startDate")
                    if spot_iso:
                        break
        if not spot_iso:
            # Fall back: use the 1M tenor's startDate (which is the spot value date)
            ipa1 = (ipa or {}).get("1M") or {}
            spot_iso = ipa1.get("startDate")
        if spot_iso:
            try:
                spot_d = date.fromisoformat(spot_iso[:10])
            except Exception:
                spot_d = date.today() + timedelta(days=2)
        else:
            spot_d = date.today() + timedelta(days=2)
        turns = generate_turns(turn_types_for(cfg), spot_d, horizon_months=cfg.max_display_m)
        return [t.to_dict() for t in turns]

    # ───── per-tenor bundle ─────
    def _tenor_bundle(self, cfg: CurrencyConfig, m: int,
                      t1: Dict[str, Quote],
                      ipa: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        sources: Dict[str, Any] = {}

        # Composite (unless derive-from-outrights ccy)
        if not cfg.derive_from_outrights:
            if not (cfg.kind == "NDF" and m == 18 and cfg.composite_18m_fallback_brokers):
                ric = cfg.swap_points_ric(m)
                sources["composite"] = self._source_entry(
                    ric, mode=cfg.value_mode_for("composite"), t1=t1)

        # Per-broker swap points
        for b in cfg.brokers:
            ric = cfg.broker_ric(m, b)
            entry = self._source_entry(ric, mode=cfg.value_mode_for(b), t1=t1)
            if entry["hasData"]:
                sources[b] = entry

        # NGN-style: derive points from broker outright
        if cfg.derive_from_outrights:
            spot_q = self._quotes.get(cfg.spot_ric, Quote())
            for b in cfg.outright_source_brokers:
                or_ric = cfg.outright_ric(m, broker=b)
                or_q = self._quotes.get(or_ric, Quote())
                if or_q.bid is None and or_q.ask is None and or_q.last is None:
                    continue
                derived = _derive_pts_from_outright(spot_q, or_q, cfg)
                if derived is None:
                    continue
                derived["ric"] = or_ric
                derived["sourceKind"] = "outright_derived"
                derived["outright"] = {
                    "bid": or_q.bid, "ask": or_q.ask, "mid": or_q.mid(),
                }
                # Freshness based on outright RIC's TIMACT
                derived["ts"] = or_q.timact_ts or or_q.ts
                derived["ageSec"] = _age(derived["ts"])
                derived["freshness"] = _freshness(derived["ts"])
                sources[b] = derived

        # Prefer IPA-derived days (real calendar, holiday-aware); fall back to approx.
        ipa_entry = (ipa or {}).get(_ipa_tenor_code(m)) if ipa else None
        days = None
        val_date = None
        fix_date = None
        if ipa_entry:
            days = ipa_entry.get("days")
            val_date = ipa_entry.get("endDate") or ipa_entry.get("valueDate")
            fix_date = ipa_entry.get("fixDate")
        if days is None:
            days = _days_for_tenor(m)  # IPA-approx: fallback when IPA unreachable
        # daysFix: calendar days from today to fixDate (null if IPA didn't return one)
        days_fix = None
        fix_lag_days = None
        if fix_date:
            try:
                days_fix = (date.fromisoformat(fix_date) - date.today()).days
            except Exception:
                days_fix = None
        if val_date and fix_date:
            try:
                fix_lag_days = (date.fromisoformat(val_date) - date.fromisoformat(fix_date)).days
            except Exception:
                fix_lag_days = None
        return {
            "days": days,
            "daysFix": days_fix,
            "valueDate": val_date,
            "fixDate": fix_date,
            "fixLagDays": fix_lag_days,
            "sources": sources,
            "hasAnyData": any(s.get("hasData") for s in sources.values()),
        }

    # ───── extended-tenor bundle (non-anchor months with broker data) ─────
    def _extended_tenor_bundle(self, cfg: CurrencyConfig, m: int,
                               t1: Dict[str, Quote]) -> Dict[str, Any]:
        """
        Lighter bundle for non-anchor months (4/5/7/8/10/11/13-17/19-23).
        Pulls composite (when expected to exist) and preferred broker (FMD for NDFs).
        No IPA, no T-1 history — frontend lazy-backfills if user needs T-1.
        """
        sources: Dict[str, Any] = {}

        # Composite — only if probe confirms it exists for this month.
        # NDF: (1,2,3,6,9,12,24) only — we never include non-anchor composite
        # rics in all_extended_rics for other months, but a composite entry
        # may still exist in a later probe (e.g. 15/18/21 deliverable). We
        # include it defensively and let hasData flag gate it.
        include_composite = (
            cfg.kind != "NDF" or m in (1, 2, 3, 6, 9, 12, 24)
        )
        if include_composite and not cfg.derive_from_outrights:
            ric = cfg.swap_points_ric(m)
            entry = self._source_entry(ric, mode=cfg.value_mode_for("composite"), t1=t1)
            if entry["hasData"]:
                sources["composite"] = entry

        # Preferred broker
        preferred = "FMD" if "FMD" in cfg.brokers else (cfg.brokers[0] if cfg.brokers else None)
        if preferred:
            ric = cfg.broker_ric(m, preferred)
            entry = self._source_entry(ric, mode=cfg.value_mode_for(preferred), t1=t1)
            if entry["hasData"]:
                sources[preferred] = entry

        return {
            "days": _days_for_tenor(m),
            "daysFix": None,
            "valueDate": None,
            "fixDate": None,
            "fixLagDays": None,
            "sources": sources,
            "hasAnyData": any(s.get("hasData") for s in sources.values()),
        }

    # ───── per-funding bundle ─────
    def _funding_bundle(self, cfg: CurrencyConfig, tenor: str,
                        t1: Dict[str, Quote]) -> Dict[str, Any]:
        sources: Dict[str, Any] = {}
        comp_ric = cfg.funding_ric(tenor)
        if comp_ric:
            entry = self._source_entry(comp_ric,
                                       mode=cfg.value_mode_for("composite"), t1=t1)
            sources["composite"] = entry
        for b in cfg.brokers:
            bric = cfg.funding_ric(tenor, broker=b)
            if not bric:
                continue
            entry = self._source_entry(bric, mode=cfg.value_mode_for(b), t1=t1)
            if entry["hasData"]:
                sources[b] = entry
        return {
            "tenor": tenor,
            "sources": sources,
            "hasAnyData": any(s.get("hasData") for s in sources.values()),
        }

    # ───── per-source entry ─────
    def _source_entry(self, ric: str, mode: str,
                      t1: Dict[str, Quote]) -> Dict[str, Any]:
        q = self._quotes.get(ric, Quote())
        tq1 = t1.get(ric, Quote())
        ts = q.timact_ts or q.ts
        has = q.bid is not None or q.ask is not None or q.last is not None
        return {
            "ric": ric,
            "bid": q.bid, "ask": q.ask, "mid": q.mid(), "last": q.last,
            "ts": ts, "ageSec": _age(ts), "freshness": _freshness(ts),
            "timact": q.timact,
            "valueMode": mode,
            "hasData": has,
            "T1": {"bid": tq1.bid, "ask": tq1.ask, "mid": tq1.mid(), "last": tq1.last},
        }

    def _ser_ric(self, ric: str, _kind: str = "T",
                 t1: Optional[Dict[str, Quote]] = None) -> Dict[str, Any]:
        """Plain quote dict for spot / sofr / ndf1mOutright where no sources-dict needed."""
        if t1 is not None:
            q = t1.get(ric, Quote())
            return {"bid": q.bid, "ask": q.ask, "mid": q.mid(), "last": q.last, "ts": None}
        q = self._quotes.get(ric, Quote())
        ts = q.timact_ts or q.ts
        return {"bid": q.bid, "ask": q.ask, "mid": q.mid(), "last": q.last, "ts": ts,
                "timact": q.timact, "freshness": _freshness(ts), "ageSec": _age(ts)}

    # ────────────────── live streaming ──────────────────
    def start_streams(self, ccy: str):
        self._active_ccy = ccy
        self._tick_counts = {"spot": 0, "fwd": 0, "brk": 0}
        cfg = CURRENCIES[ccy]

        # Spot (+ 1M outright for NDF)
        spot_rics = [cfg.spot_ric]
        if cfg.kind == "NDF":
            # derive_from_outrights ccys don't have a 1MNDFOR= composite, skip
            if not cfg.derive_from_outrights:
                spot_rics.append(f"{cfg.code}1MNDFOR=")
        log.info("SPOT stream %s: %s", ccy, spot_rics)
        self.lseg.subscribe(tag=f"spot-{ccy}", rics=spot_rics, fields=FIELDS_QUOTE,
                            on_update=lambda r, f: self._on_spot(r, f))

        # Forwards (composite swap pts) — 15s throttle
        fwd_rics = []
        for m in cfg.anchor_tenors_m:
            if cfg.derive_from_outrights:
                continue
            if cfg.kind == "NDF" and m == 18 and cfg.composite_18m_fallback_brokers:
                continue
            fwd_rics.append(cfg.swap_points_ric(m))
        if fwd_rics:
            log.info("FWD stream %s: %d", ccy, len(fwd_rics))
            self.lseg.subscribe(tag=f"fwd-{ccy}", rics=fwd_rics, fields=FIELDS_QUOTE,
                                on_update=lambda r, f: self._on_fwd(r, f))

        # Brokers (tick) — includes MBGL outrights for NGN, funding brokers for deliverables,
        # plus the extended-tenor composite+FMD feeds so off-anchor months update live.
        br_rics = list(all_broker_rics(ccy))
        br_rics += list(all_outright_rics(ccy))
        br_rics += list(all_extended_rics(ccy))
        br_rics += list(all_weekly_rics(ccy))
        if cfg.kind == "DELIVERABLE":
            br_rics += all_funding_rics(ccy)
        br_rics = list(set(br_rics))
        if br_rics:
            log.info("BRK stream %s: %d", ccy, len(br_rics))
            self.lseg.subscribe(tag=f"brk-{ccy}", rics=br_rics, fields=FIELDS_QUOTE,
                                on_update=lambda r, f: self._on_brk(r, f))

    def stop_streams(self, ccy: Optional[str] = None):
        c = ccy or self._active_ccy
        if not c:
            return
        for pref in ("spot", "fwd", "brk"):
            self.lseg.unsubscribe(f"{pref}-{c}")

    def _apply(self, ric: str, upd: Dict[str, Any]) -> Quote:
        q = self._quotes.get(ric) or Quote()
        try:
            upd = dict(upd)
        except Exception:
            pass
        if "BID" in upd:       q.bid  = _num(upd["BID"])
        if "ASK" in upd:       q.ask  = _num(upd["ASK"])
        if "TRDPRC_1" in upd:  q.last = _num(upd["TRDPRC_1"])
        if "PRIMACT_1" in upd and q.bid is None: q.bid = _num(upd["PRIMACT_1"])
        if "SEC_ACT_1" in upd and q.ask is None: q.ask = _num(upd["SEC_ACT_1"])
        if "TIMACT" in upd:
            ts_parsed = _parse_timact(upd["TIMACT"])
            if ts_parsed is not None:
                q.timact = str(upd["TIMACT"])
                q.timact_ts = ts_parsed
        q.ts = time.time()
        self._quotes[ric] = q
        return q

    def _on_spot(self, ric, fields):
        self._tick_counts["spot"] = self._tick_counts.get("spot", 0) + 1
        q = self._apply(ric, fields)
        self._fanout("spot", {"ric": ric, "bid": q.bid, "ask": q.ask,
                              "mid": q.mid(), "ts": q.ts, "timact": q.timact})

    def _on_fwd(self, ric, fields):
        self._tick_counts["fwd"] = self._tick_counts.get("fwd", 0) + 1
        q = self._apply(ric, fields)
        now = time.time()
        if now - self._last_fwd_emit.get(ric, 0) >= THROTTLE_FORWARD_SEC:
            self._last_fwd_emit[ric] = now
            self._fanout("forwards", {"ric": ric, "bid": q.bid, "ask": q.ask,
                                      "mid": q.mid(), "ts": q.ts, "timact": q.timact})

    def _on_brk(self, ric, fields):
        self._tick_counts["brk"] = self._tick_counts.get("brk", 0) + 1
        q = self._apply(ric, fields)
        self._fanout("brokers", {"ric": ric, "bid": q.bid, "ask": q.ask,
                                 "mid": q.mid(), "ts": q.ts, "timact": q.timact})

    # ────────────────── pub/sub ──────────────────
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
        for q in list(self._subscribers.get(channel, set())):
            try:
                self._loop.call_soon_threadsafe(_safe_put, q, msg)
            except Exception as e:
                log.warning("fanout %s: %s", channel, e)

    # ────────────────── history ──────────────────
    def get_history(self, ccy: str,
                    period: str = "1Y",
                    contributor: Optional[str] = None,
                    extra_rics: Optional[List[str]] = None,
                    tenor: Optional[str] = None) -> Dict[str, Any]:
        """
        Historical bars for swap pts + spot.
        period: '1D','5D','1M','3M','6M','1Y','3Y','5Y','10Y','Max'.
        contributor: if given, use broker RICs for swap pts; else composite.
        extra_rics: optional list of additional RICs (e.g. specific broker feeds the
                    frontend wants alongside composite — per-broker history toggle).

        Response includes `ricMeta` mapping each RIC to:
            {kind: "spot"|"swap"|"outright"|"sofr"|"funding",
             month: float|None, source: "composite"|<broker>,
             valueMode: "pips"|"outright"}
        Frontend uses valueMode to convert raw bars → display pips correctly per
        RIC, even when one history mixes RICs of different value modes (e.g. NDF
        18M composite fallback uses a broker quote in pips while 1–12M composite
        is in outright differences).
        """
        cfg = CURRENCIES[ccy]
        start, interval = _resolve_period(period)

        # Auto-detected per-source value_mode overrides from the most recent
        # snapshot build. Falls back to cfg.value_mode_for(source) if no
        # override has been recorded yet (cold start / detection ambiguous).
        overrides = self._value_mode_overrides.get(ccy, {})
        def vmode(name: str) -> str:
            return overrides.get(name, cfg.value_mode_for(name))

        rics: List[str] = [cfg.spot_ric]
        ric_meta: Dict[str, Dict[str, Any]] = {
            cfg.spot_ric: {"kind": "spot", "month": 0, "source": "spot",
                           "valueMode": "outright", "pipFactor": cfg.pip_factor},
        }
        # Funding-tenor override: query ON/TN/SN RICs for that single funding tenor.
        if tenor and tenor.upper() in FUNDING_TENORS and cfg.kind == "DELIVERABLE":
            t = tenor.upper()
            base = cfg.funding_ric(t)
            if base:
                rics.append(base)
                ric_meta[base] = {"kind": "funding", "month": None,
                                  "source": "composite",
                                  "valueMode": vmode("composite"),
                                  "pipFactor": cfg.pip_factor, "tenor": t}
            for b in cfg.brokers:
                br = cfg.funding_ric(t, broker=b)
                if br:
                    rics.append(br)
                    ric_meta[br] = {"kind": "funding", "month": None,
                                    "source": b,
                                    "valueMode": vmode(b),
                                    "pipFactor": cfg.pip_factor, "tenor": t}
            if extra_rics:
                for er in extra_rics:
                    if er not in ric_meta:
                        ric_meta[er] = {"kind": "funding", "month": None,
                                        "source": "extra",
                                        "valueMode": vmode("composite"),
                                        "pipFactor": cfg.pip_factor, "tenor": t}
                rics = list(dict.fromkeys(rics + extra_rics))
            end = date.today()
            kwargs = {"rics": rics, "fields": ["BID", "ASK", "TRDPRC_1"],
                      "interval": interval, "end": end.isoformat()}
            if start is not None:
                kwargs["start"] = start.isoformat()
            hist = self.lseg.get_history(**kwargs)
            return {
                "ccy": ccy, "pair": cfg.pair, "kind": cfg.kind,
                "period": period, "interval": interval,
                "start": start.isoformat() if start else None,
                "end": end.isoformat(),
                "contributor": contributor, "tenor": t,
                "rics": rics, "ricMeta": ric_meta, "history": hist,
            }
        if contributor:
            for m in cfg.anchor_tenors_m:
                r = cfg.broker_ric(m, contributor)
                rics.append(r)
                ric_meta[r] = {"kind": "swap", "month": m, "source": contributor,
                               "valueMode": vmode(contributor),
                               "pipFactor": cfg.pip_factor}
        else:
            if cfg.derive_from_outrights:
                # NGN: "composite" history = use first outright broker
                pri = cfg.outright_source_brokers[0] if cfg.outright_source_brokers else None
                if pri:
                    for m in cfg.anchor_tenors_m:
                        r = cfg.outright_ric(m, broker=pri)
                        rics.append(r)
                        # outright_ric carries OUTRIGHT prices (not swap pts);
                        # frontend will diff against spot to derive pts.
                        ric_meta[r] = {"kind": "outright", "month": m,
                                       "source": pri,
                                       "valueMode": "outright",
                                       "pipFactor": cfg.pip_factor,
                                       "deriveFromSpot": True}
            else:
                for m in cfg.anchor_tenors_m:
                    if cfg.kind == "NDF" and m == 18 and cfg.composite_18m_fallback_brokers:
                        # use first fallback broker for 18M composite history
                        b = cfg.composite_18m_fallback_brokers[0]
                        r = cfg.broker_ric(m, b)
                        rics.append(r)
                        # CRITICAL: this broker may quote in a different value_mode
                        # than the composite. ricMeta tags it with the broker's mode
                        # (post auto-detect override) so the frontend transforms it
                        # correctly.
                        ric_meta[r] = {"kind": "swap", "month": m, "source": b,
                                       "valueMode": vmode(b),
                                       "pipFactor": cfg.pip_factor,
                                       "fallback": "composite_missing"}
                    else:
                        r = cfg.swap_points_ric(m)
                        rics.append(r)
                        ric_meta[r] = {"kind": "swap", "month": m,
                                       "source": "composite",
                                       "valueMode": vmode("composite"),
                                       "pipFactor": cfg.pip_factor}

        if extra_rics:
            for er in extra_rics:
                if er not in ric_meta:
                    # Best-effort tag for extras (frontend should still work).
                    ric_meta[er] = {"kind": "swap", "month": None,
                                    "source": "extra",
                                    "valueMode": vmode("composite"),
                                    "pipFactor": cfg.pip_factor}
            rics = list(dict.fromkeys(rics + extra_rics))

        # Append SOFR history — single tenor-matched RIC if caller specified `tenor`,
        # else the full SOFR anchor set so frontend can interpolate per-date.
        sofr_rics: List[str] = []
        if tenor and tenor.upper() not in FUNDING_TENORS:
            s = _sofr_ric_for_tenor(tenor)
            if s:
                sofr_rics.append(s)
        if not sofr_rics:
            sofr_rics = list(SOFR_RICS.values())
        for sr in sofr_rics:
            if sr not in ric_meta:
                ric_meta[sr] = {"kind": "sofr", "month": None,
                                "source": "USD", "valueMode": "pct",
                                "pipFactor": 1}
        rics = list(dict.fromkeys(rics + sofr_rics))

        end = date.today()
        kwargs = {"rics": rics, "fields": ["BID", "ASK", "TRDPRC_1"],
                  "interval": interval, "end": end.isoformat()}
        if start is not None:
            kwargs["start"] = start.isoformat()
        hist = self.lseg.get_history(**kwargs)
        # Opportunistic: every RIC in this daily history carries T-1 as its
        # penultimate bar — absorb into t1 cache so future IY D/D lookups
        # don't re-fetch.
        if interval == "daily":
            self.absorb_history_as_t1(hist)

        return {
            "ccy": ccy, "pair": cfg.pair, "kind": cfg.kind,
            "period": period, "interval": interval,
            "start": start.isoformat() if start else None,
            "end": end.isoformat(),
            "contributor": contributor,
            "rics": rics,
            "ricMeta": ric_meta,
            "sofrRics": sofr_rics,
            "history": hist,
        }

    def get_history_custom_dates(self, ccy: str,
                                 near_date: str, far_date: str,
                                 period: str = "1Y",
                                 contributor: Optional[str] = None) -> Dict[str, Any]:
        """
        Time series for a user-defined fwd-fwd spread with FIXED absolute dates.
        Strategy: pull daily anchor-tenor curves, for each historical day
        interpolate the curve to (near_date, far_date) by days-to-date,
        then return the spread (= far - near) per day.
        """
        cfg = CURRENCIES[ccy]
        start, interval = _resolve_period(period)

        # Build RIC list AND a per-RIC mode tag so we can normalize each bar to
        # "display pips" regardless of whether the source quotes in pips or in
        # outright-difference. This is what fixes the silent units-mixing bug
        # where (e.g.) NDF 18M used a broker fallback in pips while the rest
        # of the composite curve was in outright units.
        # mode: "pips" → bar value is already in pips
        #       "outright" → bar value × pip_factor = pips
        #       "outright_abs" → bar carries an absolute outright price; pts =
        #                        (out − spot) × pip_factor (used for EGP/NGN)
        # Auto-detected per-source value_mode overrides from the most recent
        # snapshot build (same source as get_history). Cold start → cfg defaults.
        overrides = self._value_mode_overrides.get(ccy, {})
        def vmode(name: str) -> str:
            return overrides.get(name, cfg.value_mode_for(name))

        rics: List[str] = [cfg.spot_ric]
        ric_mode: Dict[str, str] = {cfg.spot_ric: "spot"}
        if contributor:
            for m in cfg.anchor_tenors_m:
                r = cfg.broker_ric(m, contributor)
                rics.append(r)
                ric_mode[r] = vmode(contributor)
        else:
            for m in cfg.anchor_tenors_m:
                if cfg.kind == "NDF" and m == 18 and cfg.composite_18m_fallback_brokers:
                    b = cfg.composite_18m_fallback_brokers[0]
                    r = cfg.broker_ric(m, b)
                    rics.append(r)
                    ric_mode[r] = vmode(b)
                elif cfg.derive_from_outrights and cfg.outright_source_brokers:
                    r = cfg.outright_ric(m, broker=cfg.outright_source_brokers[0])
                    rics.append(r)
                    ric_mode[r] = "outright_abs"
                else:
                    r = cfg.swap_points_ric(m)
                    rics.append(r)
                    ric_mode[r] = vmode("composite")

        # SOFR history for the USD leg of a fwd-fwd implied yield. Request the
        # full SOFR anchor set (same as get_history) so a rate can be
        # interpolated at BOTH the near and far value-date windows per bar.
        sofr_rics: List[str] = list(SOFR_RICS.values())
        sofr_ric_months: Dict[str, int] = {v: k for k, v in SOFR_RICS.items()}
        for sr in sofr_rics:
            ric_mode[sr] = "sofr"
        rics = list(dict.fromkeys(rics + sofr_rics))

        # ricMeta mirrors get_history's conventions (kind / valueMode /
        # pipFactor) so the frontend can reuse buildSpotMap / buildSofrHist on
        # this response to populate per-date spot + SOFR for the IY view.
        ric_meta: Dict[str, Dict[str, Any]] = {}
        for r, md in ric_mode.items():
            if md == "spot":
                ric_meta[r] = {"kind": "spot", "month": 0, "source": "spot",
                               "valueMode": "outright", "pipFactor": cfg.pip_factor}
            elif md == "sofr":
                ric_meta[r] = {"kind": "sofr", "month": None, "source": "USD",
                               "valueMode": "pct", "pipFactor": 1}
            else:
                ric_meta[r] = {"kind": "swap",
                               "month": _tenor_months_from_ric(r, cfg),
                               "source": contributor or "composite",
                               "valueMode": md, "pipFactor": cfg.pip_factor}

        end = date.today()
        kwargs = {"rics": rics, "fields": ["BID", "ASK", "TRDPRC_1"],
                  "interval": interval, "end": end.isoformat()}
        if start is not None:
            kwargs["start"] = start.isoformat()
        hist = self.lseg.get_history(**kwargs)

        near_d = _parse_iso(near_date)
        far_d = _parse_iso(far_date)
        if near_d is None or far_d is None:
            raise ValueError(f"invalid dates: near={near_date} far={far_date}")

        # Build per-day curves of swap points (in display pips).
        by_date: Dict[str, Dict[int, float]] = {}
        spot_by_date: Dict[str, float] = {}
        sofr_by_date: Dict[str, Dict[int, float]] = {}
        PF = float(cfg.pip_factor)
        for ric, bars in (hist or {}).items():
            mode = ric_mode.get(ric, "pips")
            for b in bars:
                d = b.get("Date") or ""
                if not d:
                    continue
                bid, ask = _num(b.get("BID")), _num(b.get("ASK"))
                last = _num(b.get("TRDPRC_1"))
                mid = (bid + ask) / 2 if (bid is not None and ask is not None) else last
                if mid is None:
                    continue
                if mode == "spot":
                    spot_by_date[d[:10]] = mid
                    continue
                if mode == "sofr":
                    sm = sofr_ric_months.get(ric)
                    if sm is not None:
                        sofr_by_date.setdefault(d[:10], {})[sm] = mid
                    continue
                m = _tenor_months_from_ric(ric, cfg)
                if m is None:
                    continue
                if mode == "outright":
                    pts_pips = mid * PF
                elif mode == "outright_abs":
                    spot_for_d = spot_by_date.get(d[:10])
                    if spot_for_d is None:
                        continue  # outright_abs requires spot for the same date
                    pts_pips = (mid - spot_for_d) * PF
                else:  # "pips"
                    pts_pips = mid
                by_date.setdefault(d[:10], {})[m] = pts_pips

        # Curves are now uniformly in display pips → spread = (far − near) pips.
        series = []
        skipped_past_maturity = 0
        skipped_curve_sparse = 0
        for d_str, curve in sorted(by_date.items()):
            near_days = (near_d - _parse_iso(d_str)).days
            far_days = (far_d - _parse_iso(d_str)).days
            if near_days < 0 or far_days < 0:
                skipped_past_maturity += 1
                continue
            near_val = _interp_curve_days(curve, near_days)
            far_val = _interp_curve_days(curve, far_days)
            if near_val is None or far_val is None:
                skipped_curve_sparse += 1
                continue
            # USD leg (SOFR) interpolated to each value-date window so the
            # frontend can build a proper fwd-fwd implied yield per bar.
            sofr_curve = sofr_by_date.get(d_str)
            sofr_near = _interp_curve_days(sofr_curve, near_days) if sofr_curve else None
            sofr_far = _interp_curve_days(sofr_curve, far_days) if sofr_curve else None
            series.append({
                "date": d_str,
                "near": near_val, "far": far_val,
                "spread": far_val - near_val,
                "nearDays": near_days, "farDays": far_days,
                "spot": spot_by_date.get(d_str),
                "sofrNear": sofr_near, "sofrFar": sofr_far,
            })

        # Diagnostic reason when series is empty so the frontend can surface a
        # specific message instead of "no historical data for this window".
        reason = None
        if not series:
            if not hist:
                reason = "LSEG returned no bars (session inactive or RICs invalid)"
            elif not by_date:
                reason = f"no anchor RICs returned valid mids ({len(rics) - 1} tenors requested)"
            elif skipped_past_maturity and not skipped_curve_sparse:
                reason = "all historical bars are past the requested far_date"
            elif skipped_curve_sparse:
                reason = "anchor curve too sparse to interpolate at requested days"

        # Count of anchor RICs requested (exclude spot + SOFR) for diagnostics.
        n_anchor_rics = sum(1 for md in ric_mode.values() if md not in ("spot", "sofr"))
        return {
            "ccy": ccy, "pair": cfg.pair,
            "nearDate": near_date, "farDate": far_date,
            "period": period, "interval": interval,
            "contributor": contributor,
            "series": series,
            "interpolated": True,
            "reason": reason,
            "ricsRequested": n_anchor_rics,
            "ricsWithData": len({m for c in by_date.values() for m in c.keys()}),
            "history": hist,
            "ricMeta": ric_meta,
            "sofrRics": sofr_rics,
        }


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────
def _days_for_tenor(m) -> int:
    return {0.25: 7, 0.5: 14, 0.75: 21,
            1: 30, 2: 61, 3: 91, 6: 182, 9: 273,
            12: 365, 18: 547, 24: 730}.get(m, int(m * 30))


def _ipa_tenor_code(m: int) -> str:
    if m < 12:
        return f"{m}M"
    if m == 12:
        return "1Y"
    if m == 18:
        return "18M"
    if m == 24:
        return "2Y"
    return f"{m}M"


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
        if v != v:
            return None
        return v
    except (TypeError, ValueError):
        return None


def _age(ts: Optional[float]) -> Optional[float]:
    if ts is None:
        return None
    return round(time.time() - ts, 1)


def _derive_pts_from_outright(spot_q: Quote, out_q: Quote,
                              cfg: CurrencyConfig) -> Optional[Dict[str, Any]]:
    """Convert broker outright → market-pts entry.  Bid/ask mapped 1:1.
    The entry's raw values are outright−spot differences, so valueMode is
    always "outright" (independent of cfg.value_mode). Applies to every
    derive_from_outrights ccy (NGN outright-mode, EGP pips-mode, etc.)."""
    if out_q.bid is None and out_q.ask is None and out_q.last is None:
        return None
    sbid, sask = spot_q.bid, spot_q.ask
    smid = spot_q.mid()
    obid, oask = out_q.bid, out_q.ask
    def _diff(o, s):
        return None if (o is None or s is None) else (o - s)
    bid = _diff(obid, sask) if (obid is not None and sask is not None) else _diff(obid, smid)
    ask = _diff(oask, sbid) if (oask is not None and sbid is not None) else _diff(oask, smid)
    mid = None
    if bid is not None and ask is not None:
        mid = (bid + ask) / 2
    elif out_q.mid() is not None and smid is not None:
        mid = out_q.mid() - smid
    return {
        "bid": bid, "ask": ask, "mid": mid, "last": None,
        # Derived pts = outright − spot (absolute price diff) → ALWAYS
        # outright-diff units, independent of the ccy's configured
        # value_mode. Tagging cfg.value_mode mis-scales pips-mode
        # derive-from-outright ccys (e.g. EGP). See diag: EGP FMD raw
        # ~0.95 EGP must display ×pip_factor, not ×1.
        "valueMode": "outright",
        "hasData": bid is not None or ask is not None or mid is not None,
    }


def _resolve_period(period: str) -> Tuple[Optional[date], str]:
    """Return (start_date, interval) for a period preset."""
    today = date.today()
    p = (period or "1Y").upper()
    if p == "1D":   return (today - timedelta(days=2),   "hourly")
    if p == "5D":   return (today - timedelta(days=7),   "hourly")
    if p == "1M":   return (today - timedelta(days=32),  "daily")
    if p == "3M":   return (today - timedelta(days=95),  "daily")
    if p == "6M":   return (today - timedelta(days=185), "daily")
    if p == "1Y":   return (today - timedelta(days=375), "daily")
    if p == "3Y":   return (today - timedelta(days=3*366),  "daily")
    if p == "5Y":   return (today - timedelta(days=5*366),  "daily")
    if p == "10Y":  return (today - timedelta(days=10*366), "daily")
    if p == "MAX":  return (None, "daily")
    return (today - timedelta(days=375), "daily")


def _parse_iso(s: str) -> Optional[date]:
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except Exception:
        return None


_TENOR_MONTH_MAP = {
    "1M": 1, "2M": 2, "3M": 3, "4M": 4, "5M": 5, "6M": 6, "7M": 7, "8M": 8,
    "9M": 9, "10M": 10, "11M": 11, "12M": 12, "1Y": 12, "18M": 18, "24M": 24, "2Y": 24,
}


def _tenor_months_from_ric(ric: str, cfg: CurrencyConfig) -> Optional[int]:
    """Extract tenor months from a RIC string for the given ccy."""
    s = ric
    # Strip ccy prefix if present
    for prefix in (cfg.code,):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    # Strip broker suffix after '='
    if "=" in s:
        s = s.split("=")[0]
    # Strip trailing NDF / NDFOR
    for tail in ("NDFOR", "NDF"):
        if s.endswith(tail):
            s = s[:-len(tail)]
            break
    return _TENOR_MONTH_MAP.get(s.upper())


def _interp_curve_days(curve: Dict[int, float], target_days: int) -> Optional[float]:
    """Linear interp on a {months → value} curve by days (months × 30.4)."""
    if not curve or target_days is None:
        return None
    pts = sorted(((int(m * 30.4), v) for m, v in curve.items()), key=lambda p: p[0])
    if target_days <= pts[0][0]:
        return pts[0][1]
    if target_days >= pts[-1][0]:
        return pts[-1][1]
    for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
        if d0 <= target_days <= d1:
            if d1 == d0:
                return v0
            w = (target_days - d0) / (d1 - d0)
            return v0 + w * (v1 - v0)
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
