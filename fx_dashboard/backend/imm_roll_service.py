"""
IMM Roll seasonality study — deep-dive tab backend.

Trader hypothesis: interbank risk warehouses at quarterly IMM dates (3rd Wed of
Mar/Jun/Sep/Dec, especially in NDF markets), so the roll flow into each IMM date
pushes the near/far forward-forward spread in a repeatable direction during the
run-up window (~1M before). This service reconstructs the HISTORY of IMM-dated
fwd-fwd implied yields from daily anchor forward-points curves and answers:
what did entering the roll ~21 business days before the near IMM date and
holding until the near leg stops trading as a forward (~5bd out for T+2)
earn, year by year?

Methodology (on par with the pricer's DF engine — same discount_curve module):
  per historical day t:  outrights F_m = S + pts_m/PF at the anchor tenors →
  USD DF curve from that day's SOFR OIS quotes (from_ois: simple ≤1Y, annual-
  coupon bootstrap beyond) → ccy DF nodes DF_usd·S/F → log-linear DF curve →
  interval DF between the two IMM dates → fwd-fwd yield on the ccy's MM basis.
  Δ_y = iff(eve of IMM) − iff(entry ≈ −21bd), one number per year — n is SMALL
  (~8 years max: the USD OIS history pins the window to Jun-2018+), so results
  are year-dots + bootstrap CIs, never smooth curves pretending confidence.

Honest limits (stated in the ⓘ manual and the payload flags):
  - Dec-containing pairs embed the YEAR-END TURN premium (turns are not
    stripped in v1) — flagged TURN_CONTAMINATED, read direction not level.
  - Spot/value dates here use weekday arithmetic (no holiday calendars) — a
    1-2 day day-count slip shifts both interpolation legs marginally; second-
    order for a Δ-study, unacceptable for pricing (use the pricer for that).
  - Universe exclusions from the data audit are hardcoded WITH their reasons —
    a currency whose history cannot support the study is excluded loudly,
    never averaged over.
"""
from __future__ import annotations

import logging
import threading
import time as _time
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from discount_curve import DiscountCurve
from ric_config import CURRENCIES, SOFR_RICS, iy_basis

log = logging.getLogger("immroll")

HIST_START = "2018-06-01"        # USD OIS (USDSROIS) daily history begins 2018-06
# Entry ~1M before the near IMM date; exit at the LAST day the near leg still
# trades as a forward — for T+2 settlement spot overtakes the IMM date ~2-3
# business days out, so ~bd −5 is the final full-curve observation.
ENTRY_BD, EXIT_BD = -21, -5
WINDOW_BD = -65                  # path shown from ~3M before
ANCHORS = [1, 2, 3, 6, 9, 12]    # candidate anchor tenors (∩ per-ccy config)
SOFR_TENORS = [1, 3, 6, 12]

ROLL_PAIRS = {"MAR_JUN": (3, 6), "JUN_SEP": (6, 9), "SEP_DEC": (9, 12), "DEC_MAR": (12, 3)}

# Data-audit exclusions (2026-09 LSEG history probe) — surfaced, never silent.
EXCLUDED: Dict[str, str] = {
    "MYR": "3M/6M/12M composite history missing ~35% of days post-2016 (BNM NDF measures) — averages would be composition-biased",
    "NGN": "broker outright history only from 2024-04 — no seasonality sample",
    "EGP": "history only from 2020-07 — ~6 cycles per pair, anecdote not seasonality",
}


def imm_date(year: int, month: int) -> date:
    """3rd Wednesday of the month (the IMM date)."""
    first = date(year, month, 1)
    return first + timedelta(days=(2 - first.weekday()) % 7 + 14)


def _next_weekday(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _add_biz(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def _add_months(d: date, m: int) -> date:
    y, mo = d.year, d.month + m
    while mo > 12:
        y, mo = y + 1, mo - 12
    import calendar as _c
    return _next_weekday(date(y, mo, min(d.day, _c.monthrange(y, mo)[1])))


def _bd_between(a: date, b: date) -> int:
    """Weekdays strictly after a, up to and including b (requires b >= a)."""
    n, d = 0, a
    while d < b:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


class ImmRollService:

    def __init__(self, lseg):
        self.lseg = lseg
        self._lock = threading.RLock()
        self._hist_cache: Dict[str, Tuple[float, Dict[str, float]]] = {}   # ric → (ts, {date: mid})
        self._study_cache: Dict[Tuple[str, str], Tuple[str, Dict[str, Any]]] = {}

    # ── data ─────────────────────────────────────────────────
    def _hist_mid(self, ric: str) -> Dict[str, float]:
        with self._lock:
            hit = self._hist_cache.get(ric)
            if hit and _time.time() - hit[0] < 24 * 3600:
                return hit[1]
        out: Dict[str, float] = {}
        try:
            h = self.lseg.get_history([ric], fields=["BID", "ASK"], interval="daily",
                                      start=HIST_START, end=date.today().isoformat())
            for bar in (h or {}).get(ric) or []:
                dt = (bar.get("Date") or "")[:10]
                b, a = bar.get("BID"), bar.get("ASK")
                try:
                    b = float(b) if b is not None else None
                    a = float(a) if a is not None else None
                except (TypeError, ValueError):
                    b = a = None
                m = (b + a) / 2.0 if (b is not None and a is not None) else (b if b is not None else a)
                if dt and m is not None:
                    out[dt] = m
        except Exception:
            log.exception("immroll: history failed for %s", ric)
        if out:                      # never cache an empty series (one 429 ≠ no data)
            with self._lock:
                self._hist_cache[ric] = (_time.time(), out)
        return out

    # ── universe ─────────────────────────────────────────────
    def universe(self) -> Dict[str, Any]:
        rows = []
        for code, cfg in CURRENCIES.items():
            anchors = [m for m in ANCHORS if m in (cfg.anchor_tenors_m or [])]
            if code in EXCLUDED:
                rows.append({"code": code, "pair": cfg.pair, "ok": False, "reason": EXCLUDED[code]})
            elif cfg.derive_from_outrights:
                rows.append({"code": code, "pair": cfg.pair, "ok": False,
                             "reason": "outright-derived pricing — no composite points history"})
            elif len([m for m in anchors if m >= 6]) == 0 or len(anchors) < 3:
                rows.append({"code": code, "pair": cfg.pair, "ok": False,
                             "reason": f"anchor tenors {anchors} cannot bracket the far IMM date"})
            else:
                rows.append({"code": code, "pair": cfg.pair, "ok": True,
                             "ndf": cfg.kind == "NDF", "iyBasis": iy_basis(code)})
        rows.sort(key=lambda r: (not r["ok"], r["code"]))
        return {"universe": rows,
                "windowNote": f"full-precision window starts {HIST_START} (USD OIS history; "
                              "no fed-funds fallback entitled) — ~8 max IMM cycles per pair",
                "rollPairs": list(ROLL_PAIRS)}

    # ── study ────────────────────────────────────────────────
    def study(self, code: str, pair_key: str) -> Dict[str, Any]:
        if code in EXCLUDED:
            return {"error": f"{code} excluded from the study: {EXCLUDED[code]}"}
        if pair_key not in ROLL_PAIRS:
            return {"error": f"unknown roll pair {pair_key}"}
        cfg = CURRENCIES.get(code)
        if cfg is None:
            return {"error": f"unknown currency {code}"}
        today_iso = date.today().isoformat()
        with self._lock:
            hit = self._study_cache.get((code, pair_key))
            if hit and hit[0] == today_iso:
                return hit[1]

        basis = iy_basis(code)
        pf = float(cfg.pip_factor or 1.0)
        anchors = [m for m in ANCHORS if m in (cfg.anchor_tenors_m or [])]

        spot_h = self._hist_mid(cfg.spot_ric)
        pts_h = {m: self._hist_mid(cfg.swap_points_ric(m)) for m in anchors}
        sofr_h = {m: self._hist_mid(SOFR_RICS[m]) for m in SOFR_TENORS}
        if not spot_h:
            return {"error": "no spot history returned (LSEG session / entitlement)"}

        lag = 1 if code in ("CAD", "TRY", "RUB", "PHP") else 2

        def sofr_at(t: str, m: int) -> Optional[float]:
            h = sofr_h.get(m) or {}
            if t in h:
                return h[t]
            d0 = date.fromisoformat(t)
            for k in range(1, 6):        # ≤5d stale tolerance, else None (no proxy)
                prev = (d0 - timedelta(days=k)).isoformat()
                if prev in h:
                    return h[prev]
            return None

        def iff_at(t: str, d_near: int, d_far: int) -> Optional[float]:
            """Fwd-fwd implied yield between two day-counts on date t, via the
            full DF pipeline (USD curve + ccy DF nodes + interval DF)."""
            s_raw = spot_h.get(t)
            if s_raw is None or s_raw <= 0:
                return None
            spot_d = _add_biz(date.fromisoformat(t), lag)
            nodes: Dict[float, float] = {}
            sofr_nodes: Dict[float, float] = {}
            for m in SOFR_TENORS:
                r = sofr_at(t, m)
                if r is not None and 0 < r < 25:
                    sofr_nodes[float((_add_months(spot_d, m) - spot_d).days)] = r
            if len(sofr_nodes) < 2:
                return None
            usd = DiscountCurve.from_ois(sofr_nodes)
            for m in anchors:
                p = (pts_h.get(m) or {}).get(t)
                if p is None:
                    continue
                if cfg.inverted:
                    f_inv = s_raw + p / pf
                    if f_inv <= 0:
                        continue
                    s_loc, f_loc = 1.0 / s_raw, 1.0 / f_inv
                else:
                    s_loc = s_raw
                    f_loc = s_raw + (p / pf if cfg.value_mode == "pips" else p)
                if f_loc <= 0:
                    continue
                dm = float((_add_months(spot_d, m) - spot_d).days)
                nodes[dm] = usd.df(dm) * s_loc / f_loc
            if len(nodes) < 3 or max(nodes) < d_far * 0.85:
                return None                       # cannot bracket the far leg — no extrapolated answers
            ccy_curve = DiscountCurve(list(nodes.items()))
            a, b = ccy_curve.df(d_near), ccy_curve.df(d_far)
            if not a or not b or b <= 0 or d_far <= d_near:
                return None
            return (a / b - 1.0) * basis / (d_far - d_near) * 100.0

        m_near, m_far = ROLL_PAIRS[pair_key]
        first_year = int(HIST_START[:4])
        events: List[Dict[str, Any]] = []
        deltas: List[Dict[str, Any]] = []
        skipped_days = 0
        this_year = date.today().year
        for y in range(first_year, this_year + 2):
            near = imm_date(y, m_near)
            far = imm_date(y + 1, m_far) if m_far <= m_near else imm_date(y, m_far)
            window_start = near - timedelta(days=int(-WINDOW_BD * 7 / 5) + 7)
            if window_start > date.today():
                continue
            path: List[Tuple[int, float]] = []
            for t in sorted(spot_h):
                td = date.fromisoformat(t)
                if td < window_start or td >= near or t < HIST_START:
                    continue
                bd = -_bd_between(td, near)
                if bd < WINDOW_BD or bd > EXIT_BD:
                    continue
                spot_d = _add_biz(td, lag)
                d_near = (near - spot_d).days
                d_far = (far - spot_d).days
                if d_near < 4:
                    continue
                v = iff_at(t, d_near, d_far)
                if v is None:
                    skipped_days += 1
                    continue
                path.append((bd, v))
            if len(path) < 10:
                continue
            # re-anchor at the observed bd closest to ENTRY_BD (must be within ±3)
            anchor = min(path, key=lambda p: abs(p[0] - ENTRY_BD))
            ev: Dict[str, Any] = {
                "year": y, "nearImm": near.isoformat(), "farImm": far.isoformat(),
                "n": len(path), "anchorBd": anchor[0],
                "path": [[bd, round(v, 4)] for bd, v in path],
                "delta": [[bd, round((v - anchor[1]) * 100, 2)] for bd, v in path],  # bp from entry
                "current": near >= date.today(),
            }
            if abs(anchor[0] - ENTRY_BD) > 3:
                ev["anchorNote"] = f"no observation near bd {ENTRY_BD} — excluded from Δ stats"
            elif not ev["current"]:
                exit_pt = min(path, key=lambda p: abs(p[0] - EXIT_BD))
                if abs(exit_pt[0] - EXIT_BD) <= 3:
                    deltas.append({"year": y, "bp": round((exit_pt[1] - anchor[1]) * 100, 2)})
            events.append(ev)

        # cross-year stats — n is SMALL: dots + bootstrap CI, no smoothing
        stats: Dict[str, Any] = {"n": len(deltas), "deltas": deltas}
        if len(deltas) >= 4:
            arr = np.array([d["bp"] for d in deltas], dtype=float)
            rng = np.random.default_rng(42)
            idx = rng.integers(0, arr.size, size=(2000, arr.size))
            means = arr[idx].mean(axis=1)
            stats.update({
                "meanBp": round(float(arr.mean()), 2),
                "medianBp": round(float(np.median(arr)), 2),
                "hitRate": round(float((arr > 0).mean()), 2),
                "ci95": [round(float(np.percentile(means, 2.5)), 2),
                         round(float(np.percentile(means, 97.5)), 2)],
            })
        # mean Δ path per bd across completed years (≥4 years at that bd)
        by_bd: Dict[int, List[float]] = {}
        for ev in events:
            if ev.get("current") or ev.get("anchorNote"):
                continue
            for bd, dv in ev["delta"]:
                by_bd.setdefault(bd, []).append(dv)
        mean_path = [[bd, round(float(np.mean(vs)), 2), len(vs)]
                     for bd, vs in sorted(by_bd.items()) if len(vs) >= 4]

        # current-year z vs seasonal norm at the same bd
        cur = next((ev for ev in events if ev.get("current")), None)
        cur_z = None
        if cur and not cur.get("anchorNote") and cur["delta"]:
            bd_now, dv_now = cur["delta"][-1]
            hist = by_bd.get(bd_now) or []
            if len(hist) >= 5 and float(np.std(hist, ddof=1)) > 0:
                cur_z = round((dv_now - float(np.mean(hist))) / float(np.std(hist, ddof=1)), 2)

        upcoming = []
        d0 = date.today()
        for yy in (d0.year, d0.year + 1):
            for m in (3, 6, 9, 12):
                im = imm_date(yy, m)
                if im >= d0 and len(upcoming) < 4:
                    upcoming.append({"date": im.isoformat(), "label": im.strftime("%b").upper(),
                                     "bd": _bd_between(d0, im)})

        flags = []
        if 12 in (m_near, m_far):
            flags.append({"code": "TURN_CONTAMINATED",
                          "detail": "a Dec leg embeds the year-end turn premium (not stripped in v1) — read the DIRECTION of the drift, treat the level with suspicion"})
        flags.append({"code": "WINDOW", "detail": f"USD OIS history pins the window to {HIST_START}+ — n is small by construction"})
        flags.append({"code": "DAYCOUNT_APPROX",
                      "detail": "weekday-arithmetic value dates (no holiday calendars) — fine for a Δ-study, not for pricing"})
        if skipped_days:
            flags.append({"code": "SKIPPED_DAYS", "count": skipped_days,
                          "detail": "days lacking a full curve (missing points/SOFR) — dropped, never interpolated over"})

        res = {
            "ccy": code, "pair": cfg.pair, "rollPair": pair_key, "iyBasis": basis,
            "entryBd": ENTRY_BD, "exitBd": EXIT_BD,
            "events": events, "stats": stats, "meanPath": mean_path,
            "currentZ": cur_z, "upcomingImm": upcoming, "flags": flags,
        }
        with self._lock:
            self._study_cache[(code, pair_key)] = (today_iso, res)
        return res
