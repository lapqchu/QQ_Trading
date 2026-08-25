"""
SG inflation model — the MODEL sub-tab of the SG Fundamentals deep-dive.

Two models, per SG_FUNDAMENTALS_PLAN.md §1.2, both honest v1s:

M1 — bottom-up component nowcast (the MAS communication structure):
  For the next unpublished CPI month, forecast each of the 14 components' m/m as
  seasonal median m/m (that calendar month, last 6 yrs, 2020 excluded) plus a
  driver overlay where we genuinely know something:
    · Utilities         — the SP regulated tariff step (known ~2wks before the
                          quarter) × an estimated CPI pass-through
    · Private transport — OLS on COE premium m/m (lags 0,1)
    · Accommodation     — OLS of component y/y on URA rental y/y (avg lag 3–6q)
  Aggregate with 2024 CPI weights (Laspeyres: All-Items = Σ wᵢIᵢ/10000 exactly,
  MAS Core = Σ_core wᵢIᵢ / Σ_core wᵢ) → headline & core y/y nowcasts.
  Validated by reconstructing the latest PUBLISHED month from components.

M2 — reduced-form core Phillips curve (monthly version of BIS Papers 142):
  core_yoy = α + β·core_yoy₋₁ + γ·IPgap + λ·ΔIPI₋₃ + θ·ΔNEER₋₆ + δ·GST + ε
  OLS, HP-filtered log-IP output gap, GST step dummies. Gives the momentum /
  demand / imported decomposition and a 6-month projection.

Backtest — expanding-window one-step-ahead over the last 36 prints for both
models vs the naive carry-forward of y/y. All computed once per TTL (6h).
"""
from __future__ import annotations

import datetime as dt
import logging
import math
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

import ext_data
from sg_fundamentals_service import (CPI_COMPONENTS, _CPI_ALL_SERIES, COE_DATASET,
                                     load_vintages, save_vintage)

log = logging.getLogger("sg_model")

_TTL = 6 * 3600
_FIT_START = "2012-01"       # model fitting window start (post-GFC regime)
_SEAS_YEARS = 6
_BACKTEST_N = 36

# Known administered tariff steps not yet visible in the (lagging) tariff series.
# {target month: {"elec": % step, "gas": % step}} — from SP Group announcements.
KNOWN_TARIFF_STEPS: Dict[str, Dict[str, float]] = {
    "2026-07": {"elec": 17.0, "gas": 7.0},   # Q3-26: 27.27→31.91 ¢/kWh ex-GST
}
# Weights inside "Utilities & other fuels" (w=282/10000): elec 179, gas 19,
# water 66, other fuels ≈18 (per 10,000 of CPI, DOS 2024 rebasing paper).
_UTIL_W = {"elec": 179.0, "gas": 19.0, "water": 66.0, "other": 18.0}

# GST step dummies for M2 (12 months of y/y level shift after each hike)
_GST_HIKES = ["2023-01", "2024-01"]

SPF_NEXT_MEETING = {  # SPF Jun-2026 Table 4 — respondents' expectations for Oct-26 MPS
    "meeting": "Oct 2026 (NLT 14 Oct)",
    "slopeUpPct": 30, "holdPct": 70,
    "note": "Jun-26 SPF: 38% expected the July tightening (it happened); 30% expect a further slope increase in October.",
}


# ───────────────────────── small numerics ─────────────────────────
def _mkey(iso: str) -> str:
    return iso[:7]


def _next_month(mk: str) -> str:
    y, m = int(mk[:4]), int(mk[5:7])
    return f"{y + (m // 12):04d}-{(m % 12) + 1:02d}"


def _shift_month(mk: str, k: int) -> str:
    y, m = int(mk[:4]), int(mk[5:7])
    t = y * 12 + (m - 1) + k
    return f"{t // 12:04d}-{(t % 12) + 1:02d}"


def _ols(y: np.ndarray, X: np.ndarray) -> Tuple[np.ndarray, float]:
    """OLS with intercept prepended by caller. Returns (beta, r2)."""
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    ss_res = float(resid @ resid)
    ss_tot = float(((y - y.mean()) @ (y - y.mean()))) or 1e-12
    return beta, 1.0 - ss_res / ss_tot


def _hp_trend(y: np.ndarray, lam: float = 129600.0) -> np.ndarray:
    """Hodrick–Prescott trend (dense solve — fine for a few hundred points)."""
    n = len(y)
    if n < 12:
        return y.copy()
    D = np.zeros((n - 2, n))
    for i in range(n - 2):
        D[i, i], D[i, i + 1], D[i, i + 2] = 1.0, -2.0, 1.0
    return np.linalg.solve(np.eye(n) + lam * (D.T @ D), y)


class _Monthly:
    """A monthly series held as {\"YYYY-MM\": value} with helpers."""
    def __init__(self, points: Dict[str, float]):
        self.p = {_mkey(k): float(v) for k, v in points.items() if v is not None}

    def months(self) -> List[str]:
        return sorted(self.p.keys())

    def last_month(self) -> Optional[str]:
        ms = self.months()
        return ms[-1] if ms else None

    def get(self, mk: str) -> Optional[float]:
        return self.p.get(mk)

    def mm(self, mk: str) -> Optional[float]:
        a, b = self.p.get(mk), self.p.get(_shift_month(mk, -1))
        return (a / b - 1.0) * 100.0 if a is not None and b is not None else None

    def yoy(self, mk: str) -> Optional[float]:
        a, b = self.p.get(mk), self.p.get(_shift_month(mk, -12))
        return (a / b - 1.0) * 100.0 if a is not None and b is not None else None

    def yoy_series(self) -> "_Monthly":
        return _Monthly({m + "-01": self.yoy(m) for m in self.months()
                         if self.yoy(m) is not None})


# ───────────────────────── the model service ─────────────────────────
class SgInflationModel:
    def __init__(self, lseg):
        self.lseg = lseg
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_ts: float = 0.0
        self._lock = threading.Lock()

    # ── data assembly ──
    def _lseg_monthly(self, ric: str, start: str = "2004-01-01") -> _Monthly:
        try:
            h = self.lseg.get_history([ric], fields=["VALUE"], interval="monthly",
                                      start=start, end=dt.date.today().isoformat())
        except Exception as e:
            log.error("history %s failed: %s", ric, e)
            return _Monthly({})
        recs = h.get(ric) or h.get("default") or []
        return _Monthly({str(r.get("Date", ""))[:10]: r.get("VALUE", r.get(ric))
                         for r in recs
                         if isinstance(r.get("VALUE", r.get(ric)), (int, float))})

    def _load(self) -> Dict[str, Any]:
        # CPI components + All Items (full history; 16 rows ≈ 26y under the cell cap)
        cpi_tbl = ext_data.singstat_table(
            "M213751", series=[_CPI_ALL_SERIES] + [c["s"] for c in CPI_COMPONENTS],
            start_year=2000)
        comp = {c["key"]: _Monthly((cpi_tbl["series"].get(c["s"]) or {}).get("points", {}))
                for c in CPI_COMPONENTS}
        allitems = _Monthly((cpi_tbl["series"].get(_CPI_ALL_SERIES) or {}).get("points", {}))
        # official MAS core index (validation + M2 target)
        core_tbl = ext_data.singstat_table("M213891", series=["1"], start_year=2000)
        core_official = _Monthly((core_tbl["series"].get("1") or {}).get("points", {}))
        # electricity tariff (monthly, lags ~a quarter — used to ESTIMATE pass-through)
        tariff_tbl = ext_data.singstat_table("M890991", series=["1"], start_year=2010)
        tariff = _Monthly((tariff_tbl["series"].get("1") or {}).get("points", {}))
        # URA private rental index (quarterly → step-interpolated monthly y/y)
        rent_tbl = ext_data.singstat_table("M212311", series=["1"], start_year=2004,
                                           quarterly=True)
        rent_q = _Monthly((rent_tbl["series"].get("1") or {}).get("points", {}))
        # COE: bidding premiums from data.gov.sg (full history 2010→, same-day fresh)
        # — the actual price signal. LSEG PQP (prevailing quota premium) is a
        # smoothed administrative series and fits car CPI poorly (r²≈0.1).
        coe_bid = self._coe_bidding_monthly()
        # LSEG PQP kept as fallback
        coe_a = self._lseg_monthly("aSGMVBPQPAC")   # cars >1600cc PQP
        coe_b = self._lseg_monthly("aSGMVBPQPBC")   # cars ≤1600cc PQP
        imp = self._lseg_monthly("aSGIMPP")
        neer = self._lseg_monthly("aSGDEOP")
        ip = self._lseg_monthly("aSGIP/C")
        return {"comp": comp, "all": allitems, "coreOff": core_official,
                "tariff": tariff, "rentQ": rent_q,
                "coeBid": coe_bid, "coeA": coe_a, "coeB": coe_b,
                "imp": imp, "neer": neer, "ip": ip,
                "srcErr": {k: t.get("error") for k, t in
                           [("cpi", cpi_tbl), ("core", core_tbl), ("tariff", tariff_tbl),
                            ("rent", rent_tbl)] if t.get("error")}}

    def _coe_bidding_monthly(self) -> _Monthly:
        """Monthly avg Cat A/B bidding premium from data.gov.sg (2010→)."""
        res = ext_data.datagov_search(COE_DATASET, limit=2500, sort="_id asc")
        by_month: Dict[str, List[float]] = {}
        for r in res.get("records", []):
            if str(r.get("vehicle_class")) not in ("Category A", "Category B"):
                continue
            try:
                by_month.setdefault(str(r.get("month")), []).append(float(r.get("premium")))
            except (TypeError, ValueError):
                continue
        return _Monthly({m + "-01": float(np.mean(v)) for m, v in by_month.items() if v})

    # ── seasonal m/m ──
    @staticmethod
    def _seasonal_mm(s: _Monthly, target: str, asof: str) -> Optional[float]:
        """Median m/m of target's calendar month over the last _SEAS_YEARS years
        with data strictly before `asof` (2020 excluded)."""
        cal = target[5:7]
        vals = []
        for m in reversed(s.months()):
            if m >= asof or m[5:7] != cal or m[:4] == "2020":
                continue
            v = s.mm(m)
            if v is not None:
                vals.append(v)
            if len(vals) >= _SEAS_YEARS:
                break
        return float(np.median(vals)) if vals else None

    # ── driver models (all fit on data strictly before `asof`) ──
    @staticmethod
    def _rent_yoy_monthly(rent_q: _Monthly, mk: str) -> Optional[float]:
        """URA rental index y/y for the quarter containing mk (step interpolation)."""
        y, m = int(mk[:4]), int(mk[5:7])
        qend = f"{y:04d}-{((m - 1) // 3 + 1) * 3:02d}"
        v = rent_q.yoy(qend)
        if v is None:  # quarter not out yet → use the latest available
            ms = [x for x in rent_q.months() if x < qend]
            v = rent_q.yoy(ms[-1]) if ms else None
        return v

    def _fit_accom(self, comp: _Monthly, rent_q: _Monthly, asof: str):
        """accom y/y ~ a + b · avg(rent y/y over lags 3..6 quarters)."""
        rows = []
        for m in comp.months():
            if m >= asof or m < _FIT_START:
                continue
            yv = comp.yoy(m)
            lags = [self._rent_yoy_monthly(rent_q, _shift_month(m, -3 * q)) for q in (3, 4, 5, 6)]
            lags = [x for x in lags if x is not None]
            if yv is not None and lags:
                rows.append((yv, float(np.mean(lags))))
        if len(rows) < 24:
            return None
        y = np.array([r[0] for r in rows]); x = np.array([r[1] for r in rows])
        X = np.column_stack([np.ones(len(x)), x])
        beta, r2 = _ols(y, X)
        return {"a": float(beta[0]), "b": float(beta[1]), "r2": round(r2, 3), "n": len(rows)}

    def _fit_privtrans(self, comp: _Monthly, coe: _Monthly, asof: str):
        """private-transport m/m ~ a + b0·coe_mm + b1·coe_mm₋₁."""
        rows = []
        for m in comp.months():
            if m >= asof or m < _FIT_START:
                continue
            yv = comp.mm(m)
            x0, x1 = coe.mm(m), coe.mm(_shift_month(m, -1))
            if None not in (yv, x0, x1):
                rows.append((yv, x0, x1))
        if len(rows) < 24:
            return None
        y = np.array([r[0] for r in rows])
        X = np.column_stack([np.ones(len(rows)), [r[1] for r in rows], [r[2] for r in rows]])
        beta, r2 = _ols(y, X)
        return {"a": float(beta[0]), "b0": float(beta[1]), "b1": float(beta[2]),
                "r2": round(r2, 3), "n": len(rows)}

    def _est_tariff_pass(self, util: _Monthly, tariff: _Monthly, asof: str) -> Dict[str, Any]:
        """Estimated CPI pass-through of tariff steps: for months with |Δtariff|>2%,
        ratio of Utilities-component m/m to (elec-share-weighted) tariff m/m."""
        ratios = []
        w_elec = _UTIL_W["elec"] / sum(_UTIL_W.values())
        for m in tariff.months():
            if m >= asof:
                continue
            tmm = tariff.mm(m)
            umm = util.mm(m)
            if tmm is not None and umm is not None and abs(tmm) > 2.0:
                ratios.append(umm / (w_elec * tmm))
        return {"pass": float(np.clip(np.median(ratios), 0.3, 1.2)) if ratios else 0.8,
                "nEvents": len(ratios)}

    # ── M1: one month's component forecast ──
    def _forecast_components(self, data: Dict[str, Any], target: str, asof: str,
                             want_detail: bool = False) -> Dict[str, Any]:
        """Forecast every component's index for `target` using data < `asof`.
        Returns headline/core y/y + per-component detail."""
        comp: Dict[str, _Monthly] = data["comp"]
        # COE driver: bidding premiums (data.gov.sg) preferred; PQP fallback
        coe_avg = data["coeBid"]
        if len(coe_avg.p) < 60:
            coe_avg = _Monthly({m + "-01": (a + b) / 2.0
                                for m in data["coeA"].months()
                                if (a := data["coeA"].get(m)) is not None
                                and (b := data["coeB"].get(m)) is not None})
        prev = _shift_month(target, -1)
        detail, idx_hat = [], {}
        for c in CPI_COMPONENTS:
            s = comp[c["key"]]
            base = s.get(prev)
            if base is None:                       # can't forecast without t-1
                detail.append({"key": c["key"], "label": c["label"], "w": c["w"],
                               "core": c["core"], "mm": None, "method": "no data"})
                continue
            mm = self._seasonal_mm(s, target, asof)
            method = "seasonal"
            if c["key"] == "utilities":
                step = KNOWN_TARIFF_STEPS.get(target)
                if step is None and data["tariff"].mm(target) is not None and abs(data["tariff"].mm(target)) > 2.0:
                    step = {"elec": data["tariff"].mm(target), "gas": 0.0}
                if step:
                    est = self._est_tariff_pass(s, data["tariff"], asof)
                    tw = sum(_UTIL_W.values())
                    mm = est["pass"] * (_UTIL_W["elec"] * step["elec"]
                                        + _UTIL_W["gas"] * step.get("gas", 0.0)) / tw
                    method = f"tariff step ×{est['pass']:.2f} pass ({est['nEvents']} events)"
            elif c["key"] == "privTrans":
                fit = self._fit_privtrans(s, coe_avg, asof)
                x0, x1 = coe_avg.mm(target), coe_avg.mm(prev)
                # r²-gate: a noise fit is worse than the seasonal baseline
                if fit and fit["r2"] >= 0.15 and x0 is not None and x1 is not None:
                    mm = fit["a"] + fit["b0"] * x0 + fit["b1"] * x1
                    method = f"COE-bid OLS r²{fit['r2']}"
                elif fit:
                    method = f"seasonal (COE fit r²{fit['r2']} < gate)"
            elif c["key"] == "accom":
                fit = self._fit_accom(s, data["rentQ"], asof)
                lags = [self._rent_yoy_monthly(data["rentQ"], _shift_month(target, -3 * q))
                        for q in (3, 4, 5, 6)]
                lags = [x for x in lags if x is not None]
                if fit and fit["r2"] >= 0.15 and lags:
                    # Trend from rents, month-pattern from history:
                    #   crawl = geometric monthly pace of the fitted y/y (never
                    #   force the level — a level target dumps any y/y gap into
                    #   one month's m/m, which blew up 2023 backtests by +9pp);
                    #   + seasonal FACTOR (this month's median m/m minus the
                    #   all-months mean) to keep the S&CC-rebate calendar.
                    yoy_hat = fit["a"] + fit["b"] * float(np.mean(lags))
                    crawl = ((1.0 + yoy_hat / 100.0) ** (1.0 / 12.0) - 1.0) * 100.0
                    seas_all = [self._seasonal_mm(s, f"2000-{mo:02d}", asof)
                                for mo in range(1, 13)]
                    seas_all = [x for x in seas_all if x is not None]
                    seas_factor = ((mm if mm is not None else 0.0)
                                   - (float(np.mean(seas_all)) if seas_all else 0.0))
                    mm = crawl + seas_factor
                    method = f"rent-lag OLS r²{fit['r2']} → crawl + seas"
                elif fit:
                    method = f"seasonal (rent fit r²{fit['r2']} < gate)"
            if mm is None:
                mm = 0.0
                method = "flat (no seasonal history)"
            idx = base * (1.0 + mm / 100.0)
            idx_hat[c["key"]] = idx
            b12 = s.get(_shift_month(target, -12))
            detail.append({"key": c["key"], "label": c["label"], "w": c["w"],
                           "core": c["core"], "mm": round(mm, 3),
                           "yoy": round((idx / b12 - 1.0) * 100.0, 2) if b12 else None,
                           "method": method})
        # aggregate
        w_all = sum(c["w"] for c in CPI_COMPONENTS)
        w_core = sum(c["w"] for c in CPI_COMPONENTS if c["core"])
        have = [c for c in CPI_COMPONENTS if c["key"] in idx_hat]
        if len(have) < len(CPI_COMPONENTS) - 1:
            return {"ok": False, "detail": detail}
        head_idx = sum(c["w"] * idx_hat[c["key"]] for c in have) / sum(c["w"] for c in have)
        core_have = [c for c in have if c["core"]]
        core_idx = sum(c["w"] * idx_hat[c["key"]] for c in core_have) / sum(c["w"] for c in core_have)
        a12 = data["all"].get(_shift_month(target, -12))
        c12 = data["coreOff"].get(_shift_month(target, -12))
        out = {"ok": True, "target": target,
               "headlineYoY": round((head_idx / a12 - 1.0) * 100.0, 2) if a12 else None,
               "coreYoY": round((core_idx / c12 - 1.0) * 100.0, 2) if c12 else None,
               "headlineIdx": round(head_idx, 3), "coreIdx": round(core_idx, 3)}
        if want_detail:
            # contribution to headline y/y per component
            for d in detail:
                s = comp.get(d["key"])
                b12 = s.get(_shift_month(target, -12)) if s else None
                if d.get("mm") is not None and b12 and a12 and d["key"] in idx_hat:
                    d["contribution"] = round((d["w"] / w_all) * (idx_hat[d["key"]] - b12) / a12 * 100.0, 3)
            out["detail"] = detail
        return out

    # ── M2: Phillips curve ──
    def _phillips(self, data: Dict[str, Any]) -> Dict[str, Any]:
        core_yoy = data["coreOff"].yoy_series()
        imp_yoy = data["imp"].yoy_series()
        neer_yoy = data["neer"].yoy_series()
        ip_m = data["ip"]
        ms = [m for m in ip_m.months() if m >= "2005-01"]
        if len(ms) < 60 or not core_yoy.p:
            return {"ok": False, "error": "insufficient data"}
        logip = np.array([math.log(ip_m.get(m)) for m in ms])
        gap = (logip - _hp_trend(logip)) * 100.0
        ipgap = _Monthly({m + "-01": g for m, g in zip(ms, gap)})

        def gst_dummy(m: str) -> float:
            return 1.0 if any(h <= m < _shift_month(h, 12) for h in _GST_HIKES) else 0.0

        rows = []
        for m in core_yoy.months():
            if m < _FIT_START:
                continue
            y = core_yoy.get(m)
            x = [core_yoy.get(_shift_month(m, -1)), ipgap.get(m),
                 imp_yoy.get(_shift_month(m, -3)), neer_yoy.get(_shift_month(m, -6))]
            if y is None or any(v is None for v in x):
                continue
            rows.append((m, y, *x, gst_dummy(m)))
        if len(rows) < 60:
            return {"ok": False, "error": f"only {len(rows)} usable months"}
        y = np.array([r[1] for r in rows])
        X = np.column_stack([np.ones(len(rows))] + [[r[i] for r in rows] for i in range(2, 7)])
        beta, r2 = _ols(y, X)
        names = ["const", "core_lag1", "ip_gap", "imp_yoy_L3", "neer_yoy_L6", "gst"]
        fitted = X @ beta
        last = rows[-1]
        contrib = {n: round(float(b * v), 3) for n, b, v in
                   zip(names[1:], beta[1:], last[2:7])}
        # 6-month projection: hold imported terms at last obs, gap decays 0.9/m
        proj, ym, g = [], last[1], last[3]
        impL, neerL = last[4], last[5]
        pm = last[0]
        for _ in range(6):
            pm = _next_month(pm)
            g *= 0.9
            ym = float(beta[0] + beta[1] * ym + beta[2] * g + beta[3] * impL
                       + beta[4] * neerL + beta[5] * gst_dummy(pm))
            proj.append({"month": pm, "coreYoY": round(ym, 2)})
        return {"ok": True, "r2": round(r2, 3), "n": len(rows),
                "coefs": {n: round(float(b), 4) for n, b in zip(names, beta)},
                "lastMonth": last[0],
                "decomposition": contrib,
                "fitted": [{"month": r[0], "actual": round(float(a), 2),
                            "fitted": round(float(f), 2)}
                           for r, a, f in zip(rows, y, fitted)][-120:],
                "projection": proj,
                "form": "core_yoy = α + β·core₋₁ + γ·IPgap + λ·ΔIPI₋₃ + θ·ΔNEER₋₆ + δ·GST"}

    # ── backtest ──
    def _backtest(self, data: Dict[str, Any]) -> Dict[str, Any]:
        months = [m for m in data["all"].months() if data["all"].yoy(m) is not None]
        targets = months[-_BACKTEST_N:]
        rows = []
        for t in targets:
            pred = self._forecast_components(data, t, asof=t)
            if not pred.get("ok"):
                continue
            act_h = data["all"].yoy(t)
            act_c = data["coreOff"].yoy(t)
            naive_h = data["all"].yoy(_shift_month(t, -1))
            naive_c = data["coreOff"].yoy(_shift_month(t, -1))
            rows.append({"month": t,
                         "actualHeadline": round(act_h, 2), "m1Headline": pred["headlineYoY"],
                         "naiveHeadline": round(naive_h, 2) if naive_h is not None else None,
                         "actualCore": round(act_c, 2) if act_c is not None else None,
                         "m1Core": pred["coreYoY"],
                         "naiveCore": round(naive_c, 2) if naive_c is not None else None})

        def rmse(a_key, p_key):
            es = [(r[a_key] - r[p_key]) for r in rows
                  if r.get(a_key) is not None and r.get(p_key) is not None]
            return round(float(np.sqrt(np.mean(np.square(es)))), 3) if es else None

        return {"n": len(rows), "rows": rows,
                "rmse": {"m1Headline": rmse("actualHeadline", "m1Headline"),
                         "naiveHeadline": rmse("actualHeadline", "naiveHeadline"),
                         "m1Core": rmse("actualCore", "m1Core"),
                         "naiveCore": rmse("actualCore", "naiveCore")}}

    # ── payload ──
    def model(self, refresh: bool = False) -> Dict[str, Any]:
        with self._lock:
            if not refresh and self._cache and (time.time() - self._cache_ts) < _TTL:
                return self._cache
            t0 = time.time()
            data = self._load()
            last_pub = data["all"].last_month()
            if last_pub is None:
                return {"error": "no CPI data", "sources": data["srcErr"]}
            target = _next_month(last_pub)
            nowcast = self._forecast_components(data, target, asof=target, want_detail=True)
            # validation: reconstruct the latest PUBLISHED month from components
            recon_h = None
            comp = data["comp"]
            have = [c for c in CPI_COMPONENTS if comp[c["key"]].get(last_pub) is not None]
            if len(have) == len(CPI_COMPONENTS):
                idx = sum(c["w"] * comp[c["key"]].get(last_pub) for c in have) \
                    / sum(c["w"] for c in have)
                recon_h = {"month": last_pub, "reconstructed": round(idx, 3),
                           "official": data["all"].get(last_pub),
                           "diffPct": round((idx / data["all"].get(last_pub) - 1) * 100, 3)}
            phillips = self._phillips(data)
            backtest = self._backtest(data)

            # ── surprise scorecard (built forward from logged vintages) ──
            # Log this build's call for the upcoming print…
            if nowcast.get("ok"):
                save_vintage(f"nowcast:{target}", {
                    "kind": "nowcast", "target": target,
                    "headline": nowcast.get("headlineYoY"), "core": nowcast.get("coreYoY")})
            # …and score every logged consensus whose print is now out.
            vint = load_vintages()
            sur_rows = []
            for key, v in vint.items():
                if v.get("kind") != "consensus":
                    continue
                rd = v.get("releaseDate") or ""
                if len(rd) < 10:
                    continue
                tgt = _shift_month(rd[:7], -1)          # Jul CPI prints ~23 Aug
                actual = (data["all"].yoy(tgt) if v["series"] == "cpiYoY"
                          else data["coreOff"].yoy(tgt))
                if actual is None or rd > dt.date.today().isoformat():
                    continue                              # not printed yet
                nc_v = vint.get(f"nowcast:{tgt}") or {}
                model_call = nc_v.get("headline" if v["series"] == "cpiYoY" else "core")
                surprise = round(actual - v["mean"], 2)
                edge = (round(model_call - v["mean"], 2)
                        if model_call is not None else None)
                sur_rows.append({
                    "month": tgt, "series": v["series"], "consensus": v["mean"],
                    "model": model_call, "actual": round(actual, 2),
                    "surprise": surprise, "modelMinusCons": edge,
                    "hit": (bool(np.sign(surprise) == np.sign(edge))
                            if edge not in (None, 0.0) and surprise != 0.0 else None),
                })
            sur_rows.sort(key=lambda r: (r["month"], r["series"]))
            hits = [r["hit"] for r in sur_rows if r["hit"] is not None]
            surprise_log = {
                "rows": sur_rows,
                "n": len(sur_rows), "hitRate": (round(sum(hits) / len(hits), 2)
                                                if hits else None),
                "note": ("Vendor stores no consensus history (ECI 96104) — this "
                         "scorecard is RECORDED FORWARD from 2026-08-24. A model-vs-"
                         "consensus gap is only a call when it exceeds ~half the "
                         "backtest RMSE."),
            }
            payload = {
                "asOf": dt.datetime.now().isoformat(timespec="seconds"),
                "lastPublished": {"month": last_pub,
                                  "headlineYoY": round(data["all"].yoy(last_pub), 2),
                                  "coreYoY": round(data["coreOff"].yoy(last_pub), 2)
                                  if data["coreOff"].yoy(last_pub) is not None else None},
                "nowcast": nowcast,
                "reconstruction": recon_h,
                "phillips": phillips,
                "backtest": backtest,
                "surpriseLog": surprise_log,
                "policy": {
                    # No-proxy rule: if the core nowcast failed, the gap/read are
                    # unknowable — return None (UI shows "—"), never a 0-based gap.
                    "reactionPrior": {
                        "coreGap": (round(nowcast["coreYoY"] - 2.0, 2)
                                    if nowcast.get("coreYoY") is not None else None),
                        "outputGap": 0.7,
                        "rule": "MR Oct-18 Box A: slope ← core gap (vs ~2% medium-term) + output gap; MR Oct-21 SF A: +1pp expected inflation → +1.7% NEER, +1pp gap → +0.9%",
                        "read": (None if nowcast.get("coreYoY") is None
                                 else "tightening bias" if nowcast["coreYoY"] > 2.0
                                 else "neutral-to-tightening" if nowcast["coreYoY"] > 1.5
                                 else "neutral"),
                    },
                    "spfNextMeeting": SPF_NEXT_MEETING,
                },
                "sources": data["srcErr"],
                "buildSecs": round(time.time() - t0, 2),
            }
            self._cache = payload
            self._cache_ts = time.time()
            return payload
