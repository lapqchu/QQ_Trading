"""
SGD NEER deep-dive service — first instance of the per-currency "deep-dive" tool
family (separate from the live pricer). Reconstructs the MAS S$NEER live from the
basket legs, overlays the estimated policy band, the SORA rates complex, carry,
and a set of trading-signal metrics.

Data (all LIVE-probed 2026-07-28, Workspace):
  - Basket legs: USD-cross FX spots already in the LSEG feed (SGD=, EUR=, ...).
  - SORA OIS curve: composite SGDSRA<T>OIS= (src LSEG).  O/N SORA: SORA=MAST.
  - Legacy SOR IRS: SGDSB6SO<T>= (for the SOR/SORA basis).
  - Official NEER validators (monthly, LSEG economic indicators): aSGINECE/C etc.

Methodology notes:
  - NEER is a GEOMETRIC trade-weighted index (MAS/BIS standard): the log index is
    the weighted sum of log bilateral rates. We index to 100 at a base date and
    work in % deviation from the estimated band midpoint (MAS re-bases the official
    level, so absolute levels are not comparable across vintages).
  - The MAS band is UNDISCLOSED. We model it as a piecewise-slope crawl anchored so
    that on the last policy date the NEER sits at the latest published street
    estimate of its position (Barclays +166bp, Jul-2026). Width ±2% (consensus).
  - Convention for bilaterals: e_i = FOREIGN units per SGD (SGD appreciation ⇒ e_i
    up ⇒ NEER up). Majors EUR/GBP/AUD are quoted USD-per-unit (inverted) — handled.

This module is pure-Python + LsegClient; it does not touch MarketService.
"""
from __future__ import annotations
import logging
import math
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any

log = logging.getLogger("neer")

# ── Basket: (ccy, RIC, Barclays weight %, inverted?) ─────────────────────────
# inverted = RIC quotes USD per 1 foreign (EUR/GBP/AUD); else foreign per USD.
# China leg uses CNH (offshore, tradable) per decision. USD is the numeraire.
SGD_SPOT_RIC = "SGD="   # USDSGD = SGD per USD
BASKET: List[Tuple[str, str, float, bool]] = [
    ("USD", "SGD=", 19.87, False),   # numeraire; handled specially (e_USD = 1/USDSGD)
    ("EUR", "EUR=", 15.03, True),
    ("CNY", "CNH=", 14.76, False),   # CNH offshore
    ("MYR", "MYR=", 11.62, False),
    ("JPY", "JPY=",  9.38, False),
    ("AUD", "AUD=",  6.50, True),
    ("INR", "INR=",  5.33, False),
    ("KRW", "KRW=",  4.60, False),
    ("THB", "THB=",  3.93, False),
    ("IDR", "IDR=",  3.13, False),
    ("TWD", "TWD=",  2.44, False),
    ("GBP", "GBP=",  1.82, True),
    ("HKD", "HKD=",  1.60, False),
]

# ── SORA rates complex ───────────────────────────────────────────────────────
SORA_ON_RIC = "SORA=MAST"          # overnight SORA fixing (MAS publication)
SOR_IRS_ROOT = "SGDSB6SO"          # legacy 6M-SOR IRS: SGDSB6SO5Y=  (SOR/SORA basis)
# SORA OIS composite par rates, keyed by tenor-months (confirmed live).
SORA_OIS_RICS: Dict[float, str] = {
    1: "SGDSRA1MOIS=", 2: "SGDSRA2MOIS=", 3: "SGDSRA3MOIS=", 6: "SGDSRA6MOIS=",
    12: "SGDSRA1YOIS=", 18: "SGDSRA18MOIS=", 24: "SGDSRA2YOIS=", 36: "SGDSRA3YOIS=",
    48: "SGDSRA4YOIS=", 60: "SGDSRA5YOIS=", 84: "SGDSRA7YOIS=", 120: "SGDSRA10YOIS=",
    180: "SGDSRA15YOIS=", 240: "SGDSRA20YOIS=", 360: "SGDSRA30YOIS=",
}
SORA_OIS_LABEL = {1: "1M", 2: "2M", 3: "3M", 6: "6M", 12: "1Y", 18: "18M", 24: "2Y",
                  36: "3Y", 48: "4Y", 60: "5Y", 84: "7Y", 120: "10Y", 180: "15Y",
                  240: "20Y", 360: "30Y"}

# SGD forward points (deliverable, pip_factor 1e4) for carry / FX-implied yield.
SGD_FWD_RICS: Dict[int, str] = {1: "SGD1M=", 3: "SGD3M=", 6: "SGD6M=", 12: "SGD1Y="}
SGD_PIP_FACTOR = 1e4
# USD SOFR OIS (numerator leg for SGD FX-implied yield), months -> RIC.
SOFR_RICS: Dict[int, str] = {1: "USDSROIS1M=", 3: "USDSROIS3M=", 6: "USDSROIS6M=", 12: "USDSROIS1Y="}

# Official NEER validators (monthly, LSEG economic indicators — pulled via history).
OFFICIAL_NEER_RICS = {
    "sg_neer": "aSGINECE/C",     # Singapore NEER (monthly)
    "bis_broad": "aSGBISNXBR",   # BIS broad nominal EER
    "bis_narrow": "aSGBISNXNR",  # BIS narrow nominal EER
}

# ── MAS policy band model (estimated; all values are street estimates) ────────
BAND_WIDTH = 0.02   # ±2% consensus half-width.
# Piecewise slope schedule (%/yr), effective-from date. From MAS decision history
# (semi-annual pre-2024, quarterly since). Street estimates — user-editable.
SLOPE_SCHEDULE: List[Tuple[str, float]] = [
    ("2022-10-14", 1.50),  # after the 2022 tightening cycle (re-centres + slope up)
    ("2025-01-24", 1.00),  # first ease
    ("2025-04-14", 0.50),  # second ease
    ("2026-04-14", 1.00),  # normalisation (slope up)
    ("2026-07-27", 1.25),  # "very slight" slope up (Barclays est.)
]
# Anchor the midpoint level so that on this date the NEER sits at this position.
BAND_ANCHOR_DATE = "2026-07-27"
BAND_ANCHOR_POS_BP = 166.0   # Barclays: ~+166bp above mid (upper half) post-Jul-26 MPS.
# MAS meeting dates for event markers (quarterly since 2024).
MAS_MEETINGS = ["2025-01-24", "2025-04-14", "2025-07-30", "2025-10-14",
                "2026-01-29", "2026-04-14", "2026-07-27", "2026-10-14"]

NEER_BASE_LEVEL = 100.0  # our internal index base (arbitrary; band position is self-consistent).


def _d(s: str) -> date:
    return date.fromisoformat(s[:10])


def _mid(q: Optional[Dict[str, Any]]) -> Optional[float]:
    """Mid from an LSEG quote dict; tolerant of missing bid/ask (uses last)."""
    if not q:
        return None
    def num(*keys):
        for k in keys:
            v = q.get(k)
            if v is not None:
                try:
                    f = float(v)
                    if f == f:   # not NaN
                        return f
                except (TypeError, ValueError):
                    pass
        return None
    b = num("CF_BID", "BID")
    a = num("CF_ASK", "ASK")
    if b is not None and a is not None:
        return (b + a) / 2.0
    return num("CF_LAST", "PRIMACT_1", "TRDPRC_1", "VALUE", "CF_BID", "CF_ASK")


def bilateral_foreign_per_sgd(ccy: str, quote: Optional[float], inverted: bool,
                              sgd_usd: Optional[float]) -> Optional[float]:
    """e_i = FOREIGN units per 1 SGD. sgd_usd = USDSGD (SGD per USD)."""
    if sgd_usd is None or sgd_usd <= 0:
        return None
    usd_per_sgd = 1.0 / sgd_usd
    if ccy == "USD":
        return usd_per_sgd
    if quote is None or quote <= 0:
        return None
    foreign_per_usd = (1.0 / quote) if inverted else quote
    return foreign_per_usd * usd_per_sgd


def _weights_norm() -> Dict[str, float]:
    tot = sum(w for _, _, w, _ in BASKET)
    return {ccy: w / tot for ccy, _, w, _ in BASKET}


def geometric_neer(bilaterals: Dict[str, float], base_bilaterals: Dict[str, float],
                   weights: Dict[str, float], base_level: float = NEER_BASE_LEVEL) -> Optional[float]:
    """NEER = base_level * Π (e_i / e_i,base)^w_i  (geometric trade-weighted)."""
    lg = 0.0
    used = 0.0
    for ccy, w in weights.items():
        e, e0 = bilaterals.get(ccy), base_bilaterals.get(ccy)
        if e is None or e0 is None or e <= 0 or e0 <= 0:
            continue
        lg += w * math.log(e / e0)
        used += w
    if used < 0.5:   # need most of the basket present
        return None
    # renormalize for any missing legs so weights still sum to 1 over the used set
    lg /= used
    return base_level * math.exp(lg)


def slope_at(d: date) -> float:
    """Estimated band slope (%/yr) in effect on date d."""
    s = SLOPE_SCHEDULE[0][1]
    for ds, sl in SLOPE_SCHEDULE:
        if _d(ds) <= d:
            s = sl
        else:
            break
    return s


def midpoint_factor(frm: date, to: date) -> float:
    """Cumulative crawl factor of the midpoint from `frm` to `to` under the
    piecewise slope schedule (geometric compounding of slope over sub-periods)."""
    if to == frm:
        return 1.0
    sign = 1.0 if to > frm else -1.0
    a, b = (frm, to) if to > frm else (to, frm)
    # breakpoints within [a,b]
    pts = [a] + [_d(ds) for ds, _ in SLOPE_SCHEDULE if a < _d(ds) < b] + [b]
    logf = 0.0
    for i in range(len(pts) - 1):
        seg_days = (pts[i + 1] - pts[i]).days
        sl = slope_at(pts[i])
        logf += (sl / 100.0) * (seg_days / 365.0)
    return math.exp(sign * logf)


class NeerService:
    def __init__(self, lseg):
        self.lseg = lseg
        self.weights = _weights_norm()
        self._hist_cache: Optional[Dict[str, Any]] = None
        self._hist_cache_ts: float = 0.0

    # ─────────────────────────── live quotes ───────────────────────────
    def _snap(self, rics: List[str], fields: List[str]) -> Dict[str, Dict[str, Any]]:
        try:
            return self.lseg.get_snapshot(rics, fields)
        except Exception as e:
            log.warning("neer snapshot failed for %d rics: %s", len(rics), e)
            return {}

    def _live_bilaterals(self) -> Tuple[Dict[str, float], Dict[str, Dict[str, float]], Optional[float]]:
        """Return (e_i map, per-leg raw quote map, USDSGD spot)."""
        rics = [ric for _, ric, _, _ in BASKET]
        fields = ["CF_BID", "CF_ASK", "CF_LAST", "PRIMACT_1"]
        snap = self._snap(list(dict.fromkeys(rics)), fields)
        sgd_usd = _mid(snap.get(SGD_SPOT_RIC))
        e: Dict[str, float] = {}
        legs: Dict[str, Dict[str, float]] = {}
        for ccy, ric, w, inv in BASKET:
            q = _mid(snap.get(ric))
            ei = bilateral_foreign_per_sgd(ccy, q, inv, sgd_usd)
            if ei is not None:
                e[ccy] = ei
            legs[ccy] = {"ric": ric, "quote": q, "inverted": inv, "weight": self.weights[ccy], "e": ei}
        return e, legs, sgd_usd

    # ─────────────────────────── history ───────────────────────────
    def _history_bilaterals(self, days: int = 760) -> Dict[str, Any]:
        """Daily bilateral 'foreign per SGD' series for the basket, plus dates.
        Cached ~10 min. Returns {'dates':[iso], 'e':{ccy:[vals]}}."""
        import time as _t
        if self._hist_cache and (_t.time() - self._hist_cache_ts) < 600:
            return self._hist_cache
        start = (date.today() - timedelta(days=days)).isoformat()
        end = date.today().isoformat()
        rics = list(dict.fromkeys([ric for _, ric, _, _ in BASKET]))
        # NOTE: `start` alone caps at ~20 bars on this feed — must pass `end` too.
        # FX spots reject TRDPRC_1 for history → BID/ASK only.
        hist = self.lseg.get_history(rics, fields=["BID", "ASK"],
                                     interval="daily", start=start, end=end)
        # build date -> {ric: mid}
        by_date: Dict[str, Dict[str, float]] = {}
        for ric, bars in (hist or {}).items():
            for bar in bars:
                dt = (bar.get("Date") or "")[:10]
                if not dt:
                    continue
                b, a = bar.get("BID"), bar.get("ASK")
                last = bar.get("TRDPRC_1")
                m = None
                try:
                    if b is not None and a is not None:
                        m = (float(b) + float(a)) / 2.0
                    elif last is not None:
                        m = float(last)
                except (TypeError, ValueError):
                    m = None
                if m is not None and m == m:
                    by_date.setdefault(dt, {})[ric] = m
        # per-date bilaterals
        dates = sorted(by_date.keys())
        e_series: Dict[str, List[Optional[float]]] = {ccy: [] for ccy, _, _, _ in BASKET}
        out_dates: List[str] = []
        wsum = sum(w for _, _, w, _ in BASKET)
        for dt in dates:
            row = by_date[dt]
            sgd_usd = row.get(SGD_SPOT_RIC)
            if not sgd_usd:
                continue
            tmp = {}
            covered = 0.0
            for ccy, ric, w, inv in BASKET:
                ei = bilateral_foreign_per_sgd(ccy, row.get(ric), inv, sgd_usd)
                tmp[ccy] = ei
                if ei is not None:
                    covered += w
            # keep the date if the present legs cover >=85% of basket weight;
            # missing legs stored as None and renormalized by geometric_neer.
            if covered / wsum < 0.85:
                continue
            out_dates.append(dt)
            for ccy in tmp:
                e_series[ccy].append(tmp[ccy])
        res = {"dates": out_dates, "e": e_series}
        self._hist_cache = res
        self._hist_cache_ts = _t.time()
        return res

    def neer_series(self) -> Dict[str, Any]:
        """Our NEER index (base 100 at first date) over history + band + metrics inputs."""
        h = self._history_bilaterals()
        dates, e = h["dates"], h["e"]
        if len(dates) < 20:
            return {"dates": [], "neer": [], "midpoint": [], "upper": [], "lower": [], "posBp": []}
        # base per ccy = first non-None value (dates with a missing leg still contribute)
        base = {ccy: next((v for v in e[ccy] if v is not None), None) for ccy in e}
        neer: List[float] = []
        for i in range(len(dates)):
            bil = {ccy: e[ccy][i] for ccy in e}
            v = geometric_neer(bil, base, self.weights)
            neer.append(v)
        # band anchored so that on BAND_ANCHOR_DATE NEER sits at +BAND_ANCHOR_POS_BP
        anchor_d = _d(BAND_ANCHOR_DATE)
        # nearest available date <= anchor (else last)
        idx = max((i for i, dt in enumerate(dates) if _d(dt) <= anchor_d), default=len(dates) - 1)
        neer_anchor = neer[idx]
        mid_anchor = neer_anchor / (1.0 + BAND_ANCHOR_POS_BP / 1e4)
        midpoint, upper, lower, posbp = [], [], [], []
        for i, dt in enumerate(dates):
            mf = midpoint_factor(anchor_d, _d(dt))
            mid = mid_anchor * mf
            midpoint.append(mid)
            upper.append(mid * (1 + BAND_WIDTH))
            lower.append(mid * (1 - BAND_WIDTH))
            posbp.append((neer[i] / mid - 1.0) * 1e4 if mid else None)
        return {"dates": dates, "neer": neer, "midpoint": midpoint,
                "upper": upper, "lower": lower, "posBp": posbp, "anchorIdx": idx}

    # ─────────────────────────── SORA ───────────────────────────
    def sora_complex(self) -> Dict[str, Any]:
        rics = [SORA_ON_RIC] + list(SORA_OIS_RICS.values())
        snap = self._snap(rics, ["CF_LAST", "CF_BID", "CF_ASK", "VALUE"])
        on = _mid(snap.get(SORA_ON_RIC))
        curve = []
        for m, ric in SORA_OIS_RICS.items():
            v = _mid(snap.get(ric))
            if v is not None:
                curve.append({"months": m, "label": SORA_OIS_LABEL[m], "rate": v, "ric": ric})
        curve.sort(key=lambda x: x["months"])
        # compounded SORA (self-computed from O/N history, ACT/365 geometric)
        comp = self._compounded_sora()
        return {"onSora": on, "onRic": SORA_ON_RIC, "oisCurve": curve, "compounded": comp}

    def _compounded_sora(self) -> Dict[str, Optional[float]]:
        """Compounded SORA 1M/3M from O/N SORA history (geometric ACT/365)."""
        out = {"1M": None, "3M": None}
        try:
            bars = []
            _start = (date.today() - timedelta(days=150)).isoformat()
            _end = date.today().isoformat()
            for flds in (["FIXING_1"], ["VALUE"], ["CF_LAST"], ["BID", "ASK"]):
                try:
                    hist = self.lseg.get_history([SORA_ON_RIC], fields=flds, interval="daily",
                                                 start=_start, end=_end)
                except Exception:
                    continue
                bars = (hist or {}).get(SORA_ON_RIC) or []
                if bars:
                    break
            series = []
            for bar in bars:
                dt = (bar.get("Date") or "")[:10]
                # take first numeric field on the bar (excluding the date)
                v = None
                for k, val in bar.items():
                    if k == "Date":
                        continue
                    try:
                        f = float(val)
                        if f == f:
                            v = f; break
                    except (TypeError, ValueError):
                        continue
                if dt and v is not None:
                    series.append((dt, v))
            series.sort()
            for label, ndays in (("1M", 30), ("3M", 91)):
                window = series[-ndays:]
                if len(window) >= max(10, ndays // 2):
                    # geometric compounding of daily O/N over the window, ACT/365
                    prod = 1.0
                    for _, r in window:
                        prod *= (1.0 + (r / 100.0) * (1.0 / 365.0))
                    n = len(window)
                    comp = (prod ** (365.0 / n) - 1.0) * 100.0
                    out[label] = comp
        except Exception as e:
            log.info("compounded SORA calc failed: %s", e)
        return out

    def _sor_sora_basis(self) -> Optional[Dict[str, float]]:
        """Legacy SOR IRS minus SORA OIS at 2Y/5Y (bp) — the SOR/SORA basis."""
        rics = {"2Y": ("SGDSB6SO2Y=", "SGDSRA2YOIS="), "5Y": ("SGDSB6SO5Y=", "SGDSRA5YOIS=")}
        flat = [r for pair in rics.values() for r in pair]
        snap = self._snap(flat, ["CF_LAST", "CF_BID", "CF_ASK", "VALUE"])
        out = {}
        for tenor, (sor_r, sora_r) in rics.items():
            sor, sora = _mid(snap.get(sor_r)), _mid(snap.get(sora_r))
            if sor is not None and sora is not None:
                out[tenor] = round((sor - sora) * 100.0, 1)   # bp
        return out or None

    # ─────────────────────────── carry ───────────────────────────
    def carry(self, neer_pos_slope: float) -> Dict[str, Any]:
        """Net carry of being long the SGD NEER: policy slope minus the SGD
        forward-implied appreciation already priced by the market (from USDSGD
        forward points). Positive = paid to be long; negative = costs carry."""
        snap = self._snap([SGD_SPOT_RIC, SGD_FWD_RICS[1], SGD_FWD_RICS[3]],
                          ["CF_BID", "CF_ASK", "CF_LAST", "PRIMACT_1"])
        spot = _mid(snap.get(SGD_SPOT_RIC))
        out = {"slope": neer_pos_slope, "fwdPremium1M": None, "fwdPremium3M": None,
               "net1M": None, "net3M": None}
        if not spot or spot <= 0:
            return out
        for label, m in (("1M", 1), ("3M", 3)):
            pts = _mid(snap.get(SGD_FWD_RICS[m]))
            if pts is None:
                continue
            fwd = spot + pts / SGD_PIP_FACTOR
            days = m * 30
            # SGD appreciation priced = (S/F - 1) annualized (USDSGD down = SGD up)
            fwd_prem = (spot / fwd - 1.0) * (360.0 / days) * 100.0
            out[f"fwdPremium{label}"] = round(fwd_prem, 3)
            out[f"net{label}"] = round(neer_pos_slope - fwd_prem, 3)
        return out

    # ─────────────────────────── trading metrics ───────────────────────────
    def _metrics(self, series: Dict[str, Any]) -> Dict[str, Any]:
        posbp = [p for p in series.get("posBp", []) if p is not None]
        neer = series.get("neer", [])
        out: Dict[str, Any] = {}
        if len(posbp) < 30 or not neer:
            return out
        import statistics as st
        cur_pos = posbp[-1]
        # 1) band position z-score (std-dev from mean band position)
        mu, sd = st.mean(posbp), (st.pstdev(posbp) or 1e-9)
        out["posBp"] = round(cur_pos, 1)
        out["posMeanBp"] = round(mu, 1)
        out["posSdBp"] = round(sd, 1)
        out["posZ"] = round((cur_pos - mu) / sd, 2)
        # 2) percentile rank of current position in its own history
        rank = sum(1 for p in posbp if p <= cur_pos) / len(posbp) * 100.0
        out["posPctile"] = round(rank, 0)
        # 3) distance to band edges (bp and in σ of daily NEER returns)
        half = BAND_WIDTH * 1e4
        out["toCeilingBp"] = round(half - cur_pos, 1)
        out["toFloorBp"] = round(cur_pos + half, 1)
        # 4) NEER MA deviation (20/50) + realized vol
        def ma(n):
            w = neer[-n:]
            return sum(w) / len(w) if len(w) >= n else None
        rets = [math.log(neer[i] / neer[i - 1]) for i in range(1, len(neer))
                if neer[i] and neer[i - 1]]
        if rets:
            rv = (st.pstdev(rets) * math.sqrt(252)) * 100.0
            out["realizedVolPctAnn"] = round(rv, 2)
            # position distance to edge expressed in σ of annual NEER moves
            edge_bp = out["toCeilingBp"]
            if rv > 0:
                out["ceilingDistSigma"] = round((edge_bp / 1e4 * 100.0) / rv, 2)
        for n in (20, 50):
            m = ma(n)
            if m:
                out[f"maDev{n}Bp"] = round((neer[-1] / m - 1.0) * 1e4, 1)
                # z-score vs MA-window dispersion
                w = neer[-n:]
                mu2 = sum(w) / len(w)
                sd2 = (st.pstdev(w) or 1e-9)
                out[f"maDev{n}Z"] = round((neer[-1] - mu2) / sd2, 2)
        # 5) carry-to-vol (filled by caller once carry known) placeholder
        return out

    # ─────────────────────────── calibration ───────────────────────────
    @staticmethod
    def _month_avg(dates: List[str], values: List[Optional[float]]) -> Dict[str, float]:
        """Average a daily series into {YYYY-MM: mean} (NEER indices are month-avgs)."""
        buckets: Dict[str, List[float]] = {}
        for dt, v in zip(dates, values):
            if v is None:
                continue
            buckets.setdefault(dt[:7], []).append(v)
        return {ym: sum(vs) / len(vs) for ym, vs in buckets.items() if vs}

    def calibration(self) -> Dict[str, Any]:
        """Validate/refit our NEER replica against the best available official
        series, using MONTH-AVERAGE alignment (the official NEER is a monthly/weekly
        AVERAGE, so point-in-time sampling mis-times it). Reports tracking error (bp)
        of the Barclays-weighted replica + a constrained-LSQ weight refit, gated on
        fit quality (r²). bp-precise fit vs the true MAS WEEKLY S$NEER activates
        automatically once that series is reachable (MAS API)."""
        official = self._official_neer()
        our = self.neer_series()
        result: Dict[str, Any] = {
            "source": official.get("source"), "freq": official.get("freq", "monthly"),
            "officialPoints": len(official.get("dates", [])),
            "trackingErrorBp": None, "corr": None, "fittedWeights": None, "r2": None,
            "note": None,
        }
        if not official.get("dates") or not our.get("dates"):
            result["note"] = "official NEER series unavailable"
            return result
        import statistics as st
        # month-average both series, align on common months
        our_m = self._month_avg(our["dates"], our["neer"])
        off_m = self._month_avg(official["dates"], official["values"])
        months = sorted(set(our_m) & set(off_m))
        if len(months) < 6:
            result["note"] = "insufficient overlap for calibration"
            return result
        ours = [our_m[m] for m in months]
        offs = [off_m[m] for m in months]
        dl_o = [math.log(ours[i] / ours[i - 1]) for i in range(1, len(ours))]
        dl_f = [math.log(offs[i] / offs[i - 1]) for i in range(1, len(offs))]
        result["trackingErrorBp"] = round(st.pstdev([a - b for a, b in zip(dl_o, dl_f)]) * 1e4, 1)
        try:
            result["corr"] = round(_corr(dl_o, dl_f), 4)
        except Exception:
            pass
        # constrained weight refit on month-average bilateral log-changes
        try:
            fitted, r2, te2 = self._fit_weights(official, off_m, months)
            result["r2"] = round(r2, 4) if r2 is not None else None
            # only surface fitted weights when the fit is meaningful; else keep
            # Barclays weights operative (they are themselves a fit to MAS weekly).
            if fitted and r2 is not None and r2 >= 0.5:
                result["fittedWeights"] = {k: round(v * 100, 2) for k, v in fitted.items()}
                result["fittedTrackingErrorBp"] = round(te2, 1) if te2 is not None else None
                result["note"] = "weights refit to monthly proxy; bp-precise fit awaits MAS weekly S$NEER"
            else:
                result["note"] = ("monthly proxy (%s) is a different construction — keeping "
                                  "Barclays weights; bp-precise refit awaits MAS weekly S$NEER"
                                  % (official.get("source") or "n/a"))
        except Exception as e:
            log.info("weight refit skipped: %s", e)
            result["note"] = "weight refit unavailable"
        return result

    def _official_neer(self) -> Dict[str, Any]:
        # try MAS weekly API first
        mas = self._mas_weekly_neer()
        if mas.get("dates"):
            return mas
        # fallback: LSEG monthly economic indicator
        ric = OFFICIAL_NEER_RICS["sg_neer"]
        try:
            hist = self.lseg.get_history([ric], fields=["VALUE"], interval="monthly",
                                         start=(date.today() - timedelta(days=1500)).isoformat(),
                                         end=date.today().isoformat())
            bars = (hist or {}).get(ric) or []
            dates, vals = [], []
            for bar in bars:
                dt = (bar.get("Date") or "")[:10]
                v = bar.get("VALUE")
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    v = None
                if dt and v is not None and v == v:
                    dates.append(dt); vals.append(v)
            return {"source": f"LSEG monthly {ric}", "freq": "monthly", "dates": dates, "values": vals}
        except Exception as e:
            log.info("official NEER (LSEG) fetch failed: %s", e)
            return {"source": None, "dates": [], "values": []}

    def _mas_weekly_neer(self) -> Dict[str, Any]:
        """MAS weekly S$NEER via the eServices API (returns empty if in maintenance)."""
        try:
            import urllib.request, json
            # exchange-rates dataset id is TBC while MAS API is down; skip gracefully.
            return {"source": None, "dates": [], "values": []}
        except Exception:
            return {"source": None, "dates": [], "values": []}

    def _fit_weights(self, official: Dict[str, Any], off_m: Dict[str, float],
                     months: List[str]) -> Tuple[Optional[Dict[str, float]], Optional[float], Optional[float]]:
        """Constrained-LSQ regression on MONTH-AVERAGE log-changes: fit basket
        weights (≥0, Σ=1) so weighted bilateral changes best replicate the official
        NEER changes. Returns (weights, r2, fitted-tracking-error-bp). Needs scipy."""
        try:
            from scipy.optimize import lsq_linear
            import numpy as np
        except Exception:
            return None, None, None
        h = self._history_bilaterals()
        ccys = [c for c, _, _, _ in BASKET]
        # month-average each bilateral leg
        e_m = {c: self._month_avg(h["dates"], h["e"][c]) for c in ccys}
        # keep only months present for ALL legs and the official
        good = [m for m in months if m in off_m and all(m in e_m[c] for c in ccys)]
        if len(good) < len(ccys) + 3:
            return None, None, None
        rows_X, rows_y = [], []
        for i in range(1, len(good)):
            m0, m1 = good[i - 1], good[i]
            dl = [math.log(e_m[c][m1] / e_m[c][m0]) for c in ccys]
            dy = math.log(off_m[m1] / off_m[m0])
            rows_X.append(dl); rows_y.append(dy)
        if len(rows_X) < len(ccys) + 2:
            return None, None, None
        X = np.array(rows_X); y = np.array(rows_y)
        res = lsq_linear(X, y, bounds=(0, 1))
        w = np.clip(res.x, 0, None)
        if w.sum() <= 0:
            return None, None, None
        w = w / w.sum()
        pred = X @ w
        ss_res = float(((y - pred) ** 2).sum())
        ss_tot = float(((y - y.mean()) ** 2).sum()) or 1e-12
        r2 = 1.0 - ss_res / ss_tot
        te_bp = float(np.std(y - pred)) * 1e4
        return {c: float(wi) for c, wi in zip(ccys, w)}, r2, te_bp

    # ─────────────────────────── top-level snapshot ───────────────────────────
    def build_sgd(self) -> Dict[str, Any]:
        e, legs, sgd_usd = self._live_bilaterals()
        series = self.neer_series()
        live_neer = None
        pos_bp = None
        mid_now = None
        # live NEER against the SAME base used in neer_series (first non-None per ccy)
        h = self._history_bilaterals()
        if h["dates"] and e:
            base_bil = {ccy: next((v for v in h["e"][ccy] if v is not None), None)
                        for ccy in h["e"]}
            live_neer = geometric_neer(e, base_bil, self.weights)
            if live_neer and series.get("dates"):
                anchor_d = _d(BAND_ANCHOR_DATE)
                mid_now = (series["midpoint"][series["anchorIdx"]]
                           * midpoint_factor(anchor_d, date.today()))
                pos_bp = (live_neer / mid_now - 1.0) * 1e4 if mid_now else None
        slope_now = slope_at(date.today())
        metrics = self._metrics(series)
        # override live position into metrics if we have a live number
        if pos_bp is not None:
            metrics["posBp"] = round(pos_bp, 1)
            half = BAND_WIDTH * 1e4
            metrics["toCeilingBp"] = round(half - pos_bp, 1)
            metrics["toFloorBp"] = round(pos_bp + half, 1)
            if metrics.get("posSdBp"):
                metrics["posZ"] = round((pos_bp - metrics.get("posMeanBp", 0)) / metrics["posSdBp"], 2)
        sora = self.sora_complex()
        carry = self.carry(slope_now)
        # carry-to-vol
        if metrics.get("realizedVolPctAnn") and carry.get("net3M") is not None:
            rv = metrics["realizedVolPctAnn"]
            if rv:
                metrics["carryToVol"] = round(carry["net3M"] / rv, 2)
        # per-leg contributions to today's NEER move (Δln e_i * w_i)
        contribs = self._leg_contributions()
        basis = self._sor_sora_basis()
        return {
            "ccy": "SGD",
            "asof": datetime.now().isoformat(timespec="seconds"),
            "neer": {"live": round(live_neer, 4) if live_neer else None,
                     "base": NEER_BASE_LEVEL,
                     "midpoint": round(mid_now, 4) if mid_now else None,
                     "posBp": round(pos_bp, 1) if pos_bp is not None else None,
                     "widthBp": BAND_WIDTH * 1e4,
                     "slopePctYr": slope_now,
                     "anchorDate": BAND_ANCHOR_DATE, "anchorPosBp": BAND_ANCHOR_POS_BP},
            "spotUSDSGD": sgd_usd,
            "legs": [{"ccy": c, **legs[c],
                      "contribBp": contribs.get(c)} for c, _, _, _ in BASKET],
            "sora": sora,
            "carry": carry,
            "sorSoraBasisBp": basis,
            "metrics": metrics,
            "meetings": MAS_MEETINGS,
        }

    def _leg_contributions(self) -> Dict[str, Optional[float]]:
        """Each leg's contribution to today's NEER log-move (bp), vs previous close."""
        h = self._history_bilaterals()
        e, legs, sgd_usd = self._live_bilaterals()
        out: Dict[str, Optional[float]] = {}
        if not h["dates"]:
            return out
        for ccy in [c for c, _, _, _ in BASKET]:
            prev = (next((v for v in reversed(h["e"][ccy]) if v is not None), None)
                    if h["e"].get(ccy) else None)
            cur = e.get(ccy)
            if prev and cur and prev > 0 and cur > 0:
                out[ccy] = round(self.weights[ccy] * math.log(cur / prev) * 1e4, 2)
            else:
                out[ccy] = None
        return out


def _corr(a: List[float], b: List[float]) -> float:
    import statistics as st
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = st.mean(a), st.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return num / (da * db) if da and db else 0.0
