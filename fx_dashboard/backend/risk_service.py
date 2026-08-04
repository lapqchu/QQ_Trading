"""
Risk Units — a per-product vol-based position-sizing calculator (a second deep-dive
tool alongside the SGD NEER monitor).

Idea: a trader already knows the product they want to trade and wants to size it to a
risk budget. They enter a target expressed in ANY of {daily P&L vol, VaR95, VaR99}
(they are linear scalings of each other) and the tool returns:
  - spot / forward outright / NDF outright  → a USD NOTIONAL
  - fwd-fwd curve trades (and IMM rolls)     → a DV01 (per 1bp of the fwd-fwd rate)
plus the full risk profile (daily vol, VaR95, VaR99; parametric + historical).

This module only computes the PRODUCT'S daily volatility (and its historical return
distribution). The linear sizing (size = target / per-unit-daily-vol) is done on the
frontend. Vol is computed ON DEMAND for the one selected product (a handful of history
series), so it stays light on the shared, rate-limited LSEG session.

Unit conventions:
  - FX products (spot / forwards / NDF outrights): daily vol = stdev of daily LOG
    returns of the outright (in %). daily $ vol = Notional_USD × dailyVol%.
  - Curve products (fwd-fwd, IMM rolls): the "rate" is the forward-forward implied
    yield (CIP). daily vol = stdev of daily CHANGES of that rate (in bp). daily $ vol
    = DV01 × dailyVol_bp. (SOFR is held at its current level across the history — its
    daily change is negligible vs the FX swap points, which drive the rate's vol.)
"""
from __future__ import annotations
import logging
import math
import statistics as st
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from ric_config import CURRENCIES, SOFR_RICS, NDF_CURRENCIES, DELIVERABLE_CURRENCIES
from discount_curve import DiscountCurve, fwd_fwd_yield

log = logging.getLogger("risk")

# Product catalogue (per currency). unit ∈ {"notional","dv01"}.
# Curve products are (near_m, far_m) fwd-fwds; SP×T are spot-start forward outrights.
SP_FWD_TENORS = [1, 3, 6, 12]                    # SP×1M, SP×3M, SP×6M, SP×1Y (outright, notional)
FWDFWD_PAIRS = [(1, 2), (2, 3), (3, 4), (1, 3), (3, 6), (6, 9), (9, 12), (12, 18)]  # fwd-fwds (DV01)

VOL_WINDOWS = [10, 20, 60, 90]
DEFAULT_WINDOW = 20


def _days(m: float) -> int:
    return max(1, round(m * 30.44))


def _tenor_label(m: int) -> str:
    return {1: "1M", 2: "2M", 3: "3M", 4: "4M", 6: "6M", 9: "9M", 12: "1Y", 18: "18M", 24: "2Y"}.get(m, f"{m}M")


def product_catalog(ccy: str) -> List[Dict[str, Any]]:
    """Products available for a currency, for the calculator dropdown."""
    cfg = CURRENCIES.get(ccy)
    if not cfg:
        return []
    out: List[Dict[str, Any]] = [{"id": "spot", "label": "Spot", "unit": "notional"}]
    for m in SP_FWD_TENORS:
        if m <= cfg.max_display_m:
            out.append({"id": f"sp{m}", "label": f"SP×{_tenor_label(m)} outright", "unit": "notional"})
    for n, f in FWDFWD_PAIRS:
        if f <= cfg.max_display_m:
            out.append({"id": f"ff{n}_{f}", "label": f"{_tenor_label(n)}×{_tenor_label(f)} fwd-fwd",
                        "unit": "dv01"})
    return out


class RiskService:
    def __init__(self, lseg):
        self.lseg = lseg
        self._cache: Dict[str, Any] = {}   # key -> (ts, result)

    # ─────────────────────────── data helpers ───────────────────────────
    def _hist_mid(self, ric: str, days: int = 400) -> List[Tuple[str, float]]:
        """Daily (date, mid) series for an FX RIC (BID/ASK)."""
        start = (date.today() - timedelta(days=days)).isoformat()
        end = date.today().isoformat()
        h = self.lseg.get_history([ric], fields=["BID", "ASK"], interval="daily", start=start, end=end)
        out: List[Tuple[str, float]] = []
        for bar in (h or {}).get(ric) or []:
            dt = (bar.get("Date") or "")[:10]
            b, a = bar.get("BID"), bar.get("ASK")
            try:
                m = (float(b) + float(a)) / 2.0 if (b is not None and a is not None) else None
            except (TypeError, ValueError):
                m = None
            if dt and m is not None and m == m:
                out.append((dt, m))
        out.sort()
        return out

    def _snap_mid(self, ric: str) -> Optional[float]:
        snap = self.lseg.get_snapshot([ric], ["CF_LAST", "CF_BID", "CF_ASK", "VALUE", "PRIMACT_1"])
        q = snap.get(ric) or {}
        def num(*keys):
            for k in keys:
                v = q.get(k)
                if v is not None:
                    try:
                        f = float(v)
                        if f == f:
                            return f
                    except (TypeError, ValueError):
                        pass
            return None
        b, a = num("CF_BID"), num("CF_ASK")
        if b is not None and a is not None:
            return (b + a) / 2.0
        return num("CF_LAST", "VALUE", "PRIMACT_1")

    def _outright_series(self, cfg, m: int) -> List[Tuple[str, float]]:
        """Daily outright series for a spot-start forward at tenor m."""
        spot = dict(self._hist_mid(cfg.spot_ric))
        pts = dict(self._hist_mid(cfg.swap_points_ric(m)))
        pf = cfg.pip_factor or 1.0
        out = []
        for dt in sorted(set(spot) & set(pts)):
            s, p = spot[dt], pts[dt]
            outright = s + (p / pf if cfg.value_mode == "pips" else p)
            if outright > 0:
                out.append((dt, outright))
        return out

    # ─────────────────────────── vol computation ───────────────────────────
    @staticmethod
    def _vol_from_levels(series: List[float], window: int, log_ret: bool) -> Optional[Dict[str, Any]]:
        """Daily vol + historical return-distribution percentiles from a level series."""
        if len(series) < window + 2:
            return None
        if log_ret:
            rets = [math.log(series[i] / series[i - 1]) for i in range(1, len(series))
                    if series[i] > 0 and series[i - 1] > 0]
        else:
            rets = [series[i] - series[i - 1] for i in range(1, len(series))]
        if len(rets) < window:
            return None
        w = rets[-window:]
        sd = st.pstdev(w)
        srt = sorted(w)
        def pct(p):  # p in (0,1), lower tail
            k = max(0, min(len(srt) - 1, int(p * len(srt))))
            return srt[k]
        return {"vol": sd, "histDown95": pct(0.05), "histDown99": pct(0.01),
                "histUp95": sorted(w)[max(0, min(len(w) - 1, int(0.95 * len(w))))], "n": len(w)}

    def _ffiy_series(self, cfg, near_m: int, far_m: int) -> List[Tuple[str, float]]:
        """Daily forward-forward implied-yield (%) series for a near×far curve trade.
        SOFR held at current level (its daily change is negligible vs FX points)."""
        spot = dict(self._hist_mid(cfg.spot_ric))
        near_pts = dict(self._hist_mid(cfg.swap_points_ric(near_m)))
        far_pts = dict(self._hist_mid(cfg.swap_points_ric(far_m)))
        pf = cfg.pip_factor or 1.0
        dn, df = _days(near_m), _days(far_m)
        # current USD curve (constant across history)
        sof_n = self._snap_mid(self._sofr_ric(near_m)) or 4.3
        sof_f = self._snap_mid(self._sofr_ric(far_m)) or 4.3
        usd = DiscountCurve.from_ois({dn: sof_n, df: sof_f})
        out = []
        for dt in sorted(set(spot) & set(near_pts) & set(far_pts)):
            s = spot[dt]
            no = s + (near_pts[dt] / pf if cfg.value_mode == "pips" else near_pts[dt])
            fo = s + (far_pts[dt] / pf if cfg.value_mode == "pips" else far_pts[dt])
            if no <= 0 or fo <= 0:
                continue
            iy = fwd_fwd_yield(no, dn, fo, df, s, usd)
            if iy is not None:
                out.append((dt, iy))
        return out

    @staticmethod
    def _sofr_ric(m: int) -> str:
        keys = sorted(SOFR_RICS.keys())
        nearest = min(keys, key=lambda k: abs(k - m))
        return SOFR_RICS[nearest]

    # ─────────────────────────── public API ───────────────────────────
    def vol(self, ccy: str, product: str, window: int = DEFAULT_WINDOW) -> Dict[str, Any]:
        import time as _t
        cfg = CURRENCIES.get(ccy)
        if not cfg:
            return {"error": f"unknown currency {ccy}"}
        window = window if window in VOL_WINDOWS else DEFAULT_WINDOW
        key = f"{ccy}|{product}|{window}"
        cached = self._cache.get(key)
        if cached and (_t.time() - cached[0]) < 900:   # 15-min cache (daily vol barely moves)
            return cached[1]

        unit = "notional"
        level = None
        vd = None
        try:
            if product == "spot":
                ser = self._hist_mid(cfg.spot_ric)
                levels = [v for _, v in ser]
                vd = self._vol_from_levels(levels, window, log_ret=True)
                level = levels[-1] if levels else None
                unit = "notional"
            elif product.startswith("sp"):
                m = int(product[2:])
                ser = self._outright_series(cfg, m)
                levels = [v for _, v in ser]
                vd = self._vol_from_levels(levels, window, log_ret=True)
                level = levels[-1] if levels else None
                unit = "notional"
            elif product.startswith("ff"):
                n, f = product[2:].split("_")
                ser = self._ffiy_series(cfg, int(n), int(f))
                levels = [v for _, v in ser]
                vd = self._vol_from_levels(levels, window, log_ret=False)   # rate CHANGES (bp)
                level = levels[-1] if levels else None
                unit = "dv01"
            else:
                return {"error": f"unknown product {product}"}
        except Exception as e:
            log.exception("risk vol %s %s failed", ccy, product)
            return {"error": str(e)[:120]}

        if not vd:
            res = {"ccy": ccy, "product": product, "unit": unit, "window": window,
                   "error": "insufficient history"}
            self._cache[key] = (_t.time(), res)
            return res

        if unit == "notional":
            # log-return vol → % ; VaR as |percentile| in %
            res = {
                "ccy": ccy, "product": product, "pair": cfg.pair, "unit": "notional",
                "window": window, "level": level, "nObs": vd["n"],
                "dailyVolPct": round(vd["vol"] * 100.0, 4),
                "histDown95Pct": round(abs(vd["histDown95"]) * 100.0, 4),
                "histDown99Pct": round(abs(vd["histDown99"]) * 100.0, 4),
            }
        else:
            # rate changes are in % (IY in %); express vol/percentiles in bp (×100)
            res = {
                "ccy": ccy, "product": product, "pair": cfg.pair, "unit": "dv01",
                "window": window, "level": level, "nObs": vd["n"],
                "dailyVolBp": round(vd["vol"] * 100.0, 3),
                "histDown95Bp": round(abs(vd["histDown95"]) * 100.0, 3),
                "histDown99Bp": round(abs(vd["histDown99"]) * 100.0, 3),
            }
        self._cache[key] = (_t.time(), res)
        return res
