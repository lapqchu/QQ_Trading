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
# O/N SORA OIS (broker-contributed; no composite exists). Try Tradition first.
SORA_ON_OIS_RICS = ["SGDSRAONOIS=TRDS", "SGDSRAONOIS=TPSG", "SGDSRAONOIS=ICSG",
                    "SGDSRAONOIS=BGCP", "SGDSRAONOIS=FMD"]
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
# Basket legs that are NDF (use the NDF outright RICs + implied spot for carry).
NDF_BASKET_LEGS = {"MYR", "INR", "KRW", "IDR", "TWD"}
# Pip factor per deliverable leg (fwd points -> outright). Majors/CNH/HKD 1e4; JPY/THB 1e2.
DELIV_PIP = {"EUR": 1e4, "GBP": 1e4, "AUD": 1e4, "CNH": 1e4, "HKD": 1e4, "JPY": 1e2, "THB": 1e2}
# USD SOFR OIS (numerator leg for SGD FX-implied yield), months -> RIC.
SOFR_RICS: Dict[int, str] = {1: "USDSROIS1M=", 3: "USDSROIS3M=", 6: "USDSROIS6M=", 12: "USDSROIS1Y="}

# Official MAS S$NEER — the real weekly series (LSEG economic indicator, ~141 level,
# weekly, ~1-month publication lag). This is the anchor: we re-base our live replica
# to it so the displayed NEER matches the market (~141), and calibrate against it.
MAS_SGD_NEER_RIC = "aSGDEOP"        # official MAS weekly S$NEER (~141)
# Secondary validators (monthly) — used only as fallback if aSGDEOP is unavailable.
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
# MAS meeting dates + what MAS did (for band-chart annotations). action ∈
# {ease, tighten, recentre, hold}; label is the short pointer text. Street reads.
MAS_MEETING_ACTIONS = [
    {"date": "2025-01-24", "action": "ease",    "label": "Slope ↓ (1st ease, ~1.0%)"},
    {"date": "2025-04-14", "action": "ease",    "label": "Slope ↓ (2nd ease, ~0.5%)"},
    {"date": "2025-07-30", "action": "hold",    "label": "Hold"},
    {"date": "2025-10-14", "action": "hold",    "label": "Hold"},
    {"date": "2026-01-29", "action": "hold",    "label": "Hold"},
    {"date": "2026-04-14", "action": "tighten", "label": "Slope ↑ (normalise, ~1.0%)"},
    {"date": "2026-07-27", "action": "tighten", "label": "Slope ↑ 'very slight' (~1.25%)"},
    {"date": "2026-10-14", "action": "hold",    "label": "Next meeting"},
]
MAS_MEETINGS = [m["date"] for m in MAS_MEETING_ACTIONS]

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
        # RE-BASE to the official MAS level (~141): scale the whole index so our
        # replica reads the market level. Band position (a ratio) and all metrics
        # (log-returns / z-scores) are scale-invariant, so this is display-only.
        k, k_src = self._rebase_scale(dates, neer)
        if k and k != 1.0:
            neer = [v * k if v is not None else None for v in neer]
            midpoint = [v * k for v in midpoint]
            upper = [v * k for v in upper]
            lower = [v * k for v in lower]
        return {"dates": dates, "neer": neer, "midpoint": midpoint,
                "upper": upper, "lower": lower, "posBp": posbp, "anchorIdx": idx,
                "scale": k, "scaleSource": k_src, "rawAnchorNeer": neer_anchor}

    def _rebase_scale(self, dates: List[str], neer: List[Optional[float]]) -> Tuple[float, Optional[str]]:
        """Scale factor k = official_latest / our_index_at_that_date, so the displayed
        NEER matches the official MAS level (~141). Cached with the official series."""
        off = self._official_neer_cached()
        if not off.get("dates"):
            return 1.0, None
        od, ov = off["dates"][-1], off["values"][-1]
        # our index at the nearest date <= the latest official date
        cand = [(dt, neer[i]) for i, dt in enumerate(dates) if dt <= od and neer[i]]
        if not cand or not ov:
            return 1.0, None
        our_v = cand[-1][1]
        return (ov / our_v, f"{off['source']} @ {od} = {ov:.2f}") if our_v else (1.0, None)

    def _official_neer_cached(self) -> Dict[str, Any]:
        import time as _t
        if getattr(self, "_off_cache", None) and (_t.time() - self._off_cache_ts) < 3600:
            return self._off_cache
        self._off_cache = self._official_neer()
        self._off_cache_ts = _t.time()
        return self._off_cache

    # ─────────────────────────── SORA ───────────────────────────
    def sora_complex(self) -> Dict[str, Any]:
        """The market SORA OIS curve (SGDSRA<T>OIS=, matches Bloomberg) plus the O/N
        SORA fixing (SORA=MAST) and the O/N SORA OIS (broker-contributed). No
        self-computed compounded rate and no SOR/SORA basis (SOR is discontinued)."""
        rics = [SORA_ON_RIC] + SORA_ON_OIS_RICS + list(SORA_OIS_RICS.values())
        snap = self._snap(rics, ["CF_LAST", "CF_BID", "CF_ASK", "VALUE"])
        on_fix = _mid(snap.get(SORA_ON_RIC))
        on_ois = next((_mid(snap.get(r)) for r in SORA_ON_OIS_RICS if _mid(snap.get(r)) is not None), None)
        on_ois_ric = next((r for r in SORA_ON_OIS_RICS if _mid(snap.get(r)) is not None), None)
        curve = []
        if on_ois is not None:
            curve.append({"months": 0, "label": "O/N", "rate": on_ois, "ric": on_ois_ric})
        for m, ric in SORA_OIS_RICS.items():
            v = _mid(snap.get(ric))
            if v is not None:
                curve.append({"months": m, "label": SORA_OIS_LABEL[m], "rate": v, "ric": ric})
        curve.sort(key=lambda x: x["months"])
        return {"onSoraFixing": on_fix, "onFixingRic": SORA_ON_RIC,
                "onSoraOis": on_ois, "onOisRic": on_ois_ric, "oisCurve": curve}

    # ─────────────────────────── carry (forward NEER − spot NEER) ───────────────
    def carry(self, neer_pos_slope: float, spot_neer_display: Optional[float] = None) -> Dict[str, Any]:
        """SGD NEER carry/roll = forward NEER − spot NEER at 1M/2M/3M/6M/12M.
        The forward NEER is the geometric basket index built from each leg's FORWARD
        outright (spot+fwd points for deliverable legs; the NDF outright for NDF legs).
        For NDF legs the SPOT is the NDF-IMPLIED spot (from the NDF outright curve),
        so spot and forward are internally consistent. carry>0 = the market prices SGD
        appreciation over the horizon (positive roll to be long); we also show it net
        of the policy slope."""
        tenor_code = {1: "1M", 2: "2M", 3: "3M", 6: "6M", 12: "1Y"}
        tenors = [1, 2, 3, 6, 12]
        # assemble RICs: spot legs + SGD fwd points + per-leg fwd (deliv pts / NDF outrights)
        rics = [ric for _, ric, _, _ in BASKET] + [f"SGD{tenor_code[t]}=" for t in tenors]
        for ccy, ric, _, _ in BASKET:
            if ccy == "USD":
                continue
            base = ric[:-1]  # strip '='
            if ccy in NDF_BASKET_LEGS:
                for t in tenors:
                    rics.append(f"{base}{tenor_code[t]}NDFOR=")
            else:
                for t in tenors:
                    rics.append(f"{base}{tenor_code[t]}=")
        snap = self._snap(list(dict.fromkeys(rics)), ["CF_BID", "CF_ASK", "CF_LAST", "PRIMACT_1"])
        sgd_spot = _mid(snap.get(SGD_SPOT_RIC))
        out: Dict[str, Any] = {"slope": neer_pos_slope, "tenors": []}
        if not sgd_spot or sgd_spot <= 0:
            return out

        # spot bilaterals (implied spot for NDF legs)
        def leg_spot(ccy, ric, inv):
            if ccy == "USD":
                return sgd_spot  # USDSGD itself, handled below
            if ccy in NDF_BASKET_LEGS:
                base = ric[:-1]
                o1 = _mid(snap.get(f"{base}1MNDFOR="))
                o2 = _mid(snap.get(f"{base}2MNDFOR="))
                if o1 and o2:
                    return 2.0 * o1 - o2      # linear back-extrapolation to spot
                return _mid(snap.get(ric))    # fall back to spot RIC
            return _mid(snap.get(ric))

        def leg_fwd(ccy, ric, inv, t):
            base = ric[:-1]
            if ccy == "USD":
                return None
            if ccy in NDF_BASKET_LEGS:
                return _mid(snap.get(f"{base}{tenor_code[t]}NDFOR="))
            pts = _mid(snap.get(f"{base}{tenor_code[t]}="))
            s = _mid(snap.get(ric))
            if pts is None or s is None:
                return None
            return s + pts / DELIV_PIP.get(ccy, 1e4)

        # SGD (USDSGD) spot + forwards
        sgd_fwd = {}
        for t in tenors:
            p = _mid(snap.get(f"SGD{tenor_code[t]}="))
            sgd_fwd[t] = (sgd_spot + p / SGD_PIP_FACTOR) if p is not None else None

        # per-leg spot 'foreign per SGD'
        e_spot = {}
        for ccy, ric, w, inv in BASKET:
            s = leg_spot(ccy, ric, inv)
            e_spot[ccy] = bilateral_foreign_per_sgd(ccy, None if ccy == "USD" else s, inv, sgd_spot)

        for t in tenors:
            if not sgd_fwd.get(t):
                continue
            e_fwd = {}
            ok = True
            for ccy, ric, w, inv in BASKET:
                f = leg_fwd(ccy, ric, inv, t)
                # forward bilateral uses the FORWARD SGD (USDSGD fwd) as the numeraire
                e_fwd[ccy] = bilateral_foreign_per_sgd(ccy, None if ccy == "USD" else f, inv, sgd_fwd[t])
            # ratio fwd/spot per leg → geometric weighted → carry
            lg = used = 0.0
            for ccy, _, w, _ in BASKET:
                es, ef = e_spot.get(ccy), e_fwd.get(ccy)
                if es and ef and es > 0 and ef > 0:
                    # sanity: skip a leg whose fwd/spot is implausible (>8% over the horizon)
                    if abs(math.log(ef / es)) > 0.20:
                        continue
                    lg += w * math.log(ef / es); used += w
            if used < 0.5:
                continue
            carry_ratio = math.exp(lg / used) - 1.0
            pts = (spot_neer_display or 0.0) * carry_ratio
            ann = carry_ratio * (12.0 / t) * 100.0
            out["tenors"].append({
                "tenor": tenor_code[t], "months": t,
                "carryPts": round(pts, 3) if spot_neer_display else None,
                "fwdVsSpotPct": round(carry_ratio * 100.0, 4),   # fwd NEER − spot NEER, %
                "annPct": round(ann, 3),                          # annualized appreciation the fwd prices
                # net carry to be LONG the band = policy slope − forward-priced appreciation
                # (negative ⇒ the forward prices more appreciation than policy delivers → costs carry)
                "netAnnPct": round(neer_pos_slope - ann, 3),
            })
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
        # Calibrate at MONTHLY frequency (month-average both series). The weekly
        # aSGDEOP is a weekly-average published with a lag, so week-over-week timing
        # offsets vs our point-sampled replica decorrelate at weekly frequency;
        # month-averaging washes that out (and is how street models fit, r²≈0.96).
        # (The weekly series is still used directly for the LEVEL re-base to ~141.)
        our_m = self._month_avg(our["dates"], our["neer"])
        off_m = self._month_avg(official["dates"], official["values"])
        months = sorted(set(our_m) & set(off_m))
        if len(months) < 6:
            result["note"] = "insufficient overlap for calibration"
            return result
        ours = [our_m[m] for m in months]; offs = [off_m[m] for m in months]
        dl_o = [math.log(ours[i] / ours[i - 1]) for i in range(1, len(ours))]
        dl_f = [math.log(offs[i] / offs[i - 1]) for i in range(1, len(offs))]
        result["trackingErrorBp"] = round(st.pstdev([a - b for a, b in zip(dl_o, dl_f)]) * 1e4, 1)
        try:
            result["corr"] = round(_corr(dl_o, dl_f), 4)
        except Exception:
            pass
        # constrained weight refit on the month-average grid
        try:
            fitted, r2, te2 = self._fit_weights(off_m, months)
            result["r2"] = round(r2, 4) if r2 is not None else None
            if fitted and r2 is not None and r2 >= 0.5:
                result["fittedWeights"] = {k: round(v * 100, 2) for k, v in fitted.items()}
                result["fittedTrackingErrorBp"] = round(te2, 1) if te2 is not None else None
                result["note"] = ("weights refit to %s (r²=%.3f); Barclays weights remain operative"
                                  % (official.get("source"), r2))
            else:
                result["note"] = ("fit vs %s inconclusive (r²=%s) — keeping Barclays weights"
                                  % (official.get("source"), result["r2"]))
        except Exception as e:
            log.info("weight refit skipped: %s", e)
            result["note"] = "weight refit unavailable"
        return result

    @staticmethod
    def _period_avg(daily_dates: List[str], daily_vals: List[Optional[float]],
                    boundaries: List[str]) -> Dict[str, float]:
        """Average a daily series over each official period (prev_boundary, boundary].
        Returns {boundary_date: mean}. Works for weekly or monthly boundaries."""
        pts = sorted((d, v) for d, v in zip(daily_dates, daily_vals) if v is not None)
        out: Dict[str, float] = {}
        prev = None
        j = 0
        for b in boundaries:
            acc = []
            while j < len(pts) and pts[j][0] <= b:
                if prev is None or pts[j][0] > prev:
                    acc.append(pts[j][1])
                j += 1
            if acc:
                out[b] = sum(acc) / len(acc)
            prev = b
        return out

    def _eci_series(self, ric: str, interval: str, days: int = 1500) -> Tuple[List[str], List[float]]:
        """Fetch an LSEG economic-indicator time series (VALUE field) as (dates, values)."""
        dates, vals = [], []
        try:
            hist = self.lseg.get_history([ric], fields=["VALUE"], interval=interval,
                                         start=(date.today() - timedelta(days=days)).isoformat(),
                                         end=date.today().isoformat())
            for bar in (hist or {}).get(ric) or []:
                dt = (bar.get("Date") or "")[:10]
                v = bar.get("VALUE")
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    v = None
                if dt and v is not None and v == v:
                    dates.append(dt); vals.append(v)
        except Exception as e:
            log.info("ECI series %s [%s] failed: %s", ric, interval, e)
        return dates, vals

    def _official_neer(self) -> Dict[str, Any]:
        """Official MAS S$NEER: the real weekly series aSGDEOP (~141). Falls back to
        the monthly aggregator only if the weekly is unavailable."""
        dates, vals = self._eci_series(MAS_SGD_NEER_RIC, "weekly", days=1500)
        if len(dates) >= 8:
            return {"source": f"MAS weekly {MAS_SGD_NEER_RIC}", "freq": "weekly",
                    "dates": dates, "values": vals}
        ric = OFFICIAL_NEER_RICS["sg_neer"]
        dates, vals = self._eci_series(ric, "monthly")
        return {"source": f"LSEG monthly {ric}" if dates else None,
                "freq": "monthly", "dates": dates, "values": vals}

    def _fit_weights(self, off_m: Dict[str, float], months: List[str]
                     ) -> Tuple[Optional[Dict[str, float]], Optional[float], Optional[float]]:
        """Constrained-LSQ regression on MONTH-AVERAGE log-changes: fit basket weights
        (≥0, Σ=1) so weighted bilateral changes best replicate the official NEER
        changes. Returns (weights, r2, fitted-TE-bp). Needs scipy."""
        try:
            from scipy.optimize import lsq_linear
            import numpy as np
        except Exception:
            return None, None, None
        h = self._history_bilaterals()
        ccys = [c for c, _, _, _ in BASKET]
        e_m = {c: self._month_avg(h["dates"], h["e"][c]) for c in ccys}
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
        # live NEER against the SAME base used in neer_series (first non-None per ccy),
        # then re-based to the official level with the SAME scale as the series (~141).
        h = self._history_bilaterals()
        scale = series.get("scale", 1.0) or 1.0
        if h["dates"] and e:
            base_bil = {ccy: next((v for v in h["e"][ccy] if v is not None), None)
                        for ccy in h["e"]}
            live_raw = geometric_neer(e, base_bil, self.weights)
            live_neer = live_raw * scale if live_raw else None
            if live_neer and series.get("dates"):
                anchor_d = _d(BAND_ANCHOR_DATE)
                mid_now = (series["midpoint"][series["anchorIdx"]]   # already scaled
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
        carry = self.carry(slope_now, spot_neer_display=live_neer)
        # carry-to-vol using the 3M annualized net carry
        c3 = next((t for t in carry.get("tenors", []) if t["months"] == 3), None)
        if metrics.get("realizedVolPctAnn") and c3 and c3.get("netAnnPct") is not None:
            rv = metrics["realizedVolPctAnn"]
            if rv:
                metrics["carryToVol"] = round(c3["netAnnPct"] / rv, 2)
        # per-leg contributions to today's NEER move (Δln e_i * w_i)
        contribs = self._leg_contributions()
        off = self._official_neer_cached()
        official = None
        if off.get("dates"):
            official = {"source": off["source"], "freq": off["freq"],
                        "lastDate": off["dates"][-1], "lastValue": round(off["values"][-1], 3)}
        return {
            "ccy": "SGD",
            "asof": datetime.now().isoformat(timespec="seconds"),
            "neer": {"live": round(live_neer, 3) if live_neer else None,
                     "midpoint": round(mid_now, 3) if mid_now else None,
                     "posBp": round(pos_bp, 1) if pos_bp is not None else None,
                     "widthBp": BAND_WIDTH * 1e4,
                     "slopePctYr": slope_now,
                     "official": official, "scaleSource": series.get("scaleSource"),
                     "anchorDate": BAND_ANCHOR_DATE, "anchorPosBp": BAND_ANCHOR_POS_BP},
            "spotUSDSGD": sgd_usd,
            "legs": [{"ccy": c, **legs[c],
                      "contribBp": contribs.get(c)} for c, _, _, _ in BASKET],
            "sora": sora,
            "carry": carry,
            "metrics": metrics,
            "meetings": MAS_MEETINGS,
            "meetingActions": MAS_MEETING_ACTIONS,
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

    # ─────────────────────────── intraday (live tick chart) ───────────────────
    def intraday_neer(self, window: str = "1d") -> Dict[str, Any]:
        """Intraday NEER series (tick-by-tick-ish) for the live chart, re-based to the
        official level. window ∈ {1d,3d,5d,20d}; 1d uses minute bars, longer hourly."""
        cfg = {"1d": ("minute", 1), "3d": ("hourly", 4), "5d": ("hourly", 7), "20d": ("hourly", 30)}
        interval, days = cfg.get(window, ("minute", 1))
        start = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
        end = datetime.now().isoformat(timespec="seconds")
        rics = list(dict.fromkeys([ric for _, ric, _, _ in BASKET]))
        try:
            hist = self.lseg.get_history(rics, fields=["BID", "ASK"], interval=interval,
                                         start=start, end=end)
        except Exception as e:
            return {"window": window, "times": [], "neer": [], "error": str(e)[:100]}
        h = self._history_bilaterals()
        base = {ccy: next((v for v in h["e"][ccy] if v is not None), None) for ccy in h["e"]}
        srs = self.neer_series()
        scale = srs.get("scale", 1.0) or 1.0
        by_ts: Dict[str, Dict[str, float]] = {}
        for ric, bars in (hist or {}).items():
            for bar in bars:
                ts = bar.get("Date") or ""
                if not ts:
                    continue
                b, a = bar.get("BID"), bar.get("ASK")
                try:
                    m = (float(b) + float(a)) / 2.0 if (b is not None and a is not None) else None
                except (TypeError, ValueError):
                    m = None
                if m is not None and m == m:
                    by_ts.setdefault(ts, {})[ric] = m
        times, neer = [], []
        prev_v = None
        last: Dict[str, float] = {}   # forward-filled last value per RIC
        for ts in sorted(by_ts):
            last.update(by_ts[ts])    # legs that didn't tick keep their prior value
            sgd_usd = last.get(SGD_SPOT_RIC)
            if not sgd_usd or len(last) < len(BASKET):   # wait until every leg has ticked once
                continue
            bil = {ccy: bilateral_foreign_per_sgd(ccy, last.get(ric), inv, sgd_usd)
                   for ccy, ric, w, inv in BASKET}
            v = geometric_neer(bil, base, self.weights)
            if not v:
                continue
            v *= scale
            # jump guard: a managed-float NEER cannot move >0.6% between intraday bars;
            # skip an outlier bar (a single stale/wide leg tick) that would spike the chart.
            if prev_v is not None and abs(math.log(v / prev_v)) > 0.006:
                continue
            prev_v = v
            times.append(ts); neer.append(round(v, 4))
        mid = None
        if srs.get("dates"):
            mid = (srs["midpoint"][srs["anchorIdx"]]
                   * midpoint_factor(_d(BAND_ANCHOR_DATE), date.today()))
        return {"window": window, "interval": interval, "times": times, "neer": neer,
                "midpoint": round(mid, 4) if mid else None,
                "upper": round(mid * (1 + BAND_WIDTH), 4) if mid else None,
                "lower": round(mid * (1 - BAND_WIDTH), 4) if mid else None,
                "count": len(neer)}

    # ─────────────────────────── analysis / strategies ─────────────────────────
    def analysis(self) -> Dict[str, Any]:
        """Strategy scan on the band POSITION (dev% from mid) — the master series for
        a managed-float index: mean-reversion (Bollinger/z ±2σ), trend (20/50 MA on the
        detrended series), band-edge fade, and a mean-reversion backtest with rolling
        Sharpe, equity curve, max drawdown and hit rate. Research-informed defaults."""
        import statistics as st
        srs = self.neer_series()
        dates, neer, posbp = srs.get("dates", []), srs.get("neer", []), srs.get("posBp", [])
        n = len(dates)
        if n < 70:
            return {"dates": [], "note": "insufficient history for analysis"}
        dev = [(p / 100.0 if p is not None else None) for p in posbp]   # band position in %

        def rollmean(x, w):
            out = [None] * len(x)
            for i in range(len(x)):
                if i >= w - 1:
                    seg = [v for v in x[i - w + 1:i + 1] if v is not None]
                    if len(seg) >= w * 0.8:
                        out[i] = sum(seg) / len(seg)
            return out

        # Bollinger / z-score on the band position (n=20, k=2)
        N, K = 20, 2.0
        sma, upper, lower, z = [None] * n, [None] * n, [None] * n, [None] * n
        for i in range(n):
            if i >= N - 1 and dev[i] is not None:
                w = [d for d in dev[i - N + 1:i + 1] if d is not None]
                if len(w) >= N * 0.8:
                    mu = sum(w) / len(w); sd = st.pstdev(w) or 1e-9
                    sma[i], upper[i], lower[i] = mu, mu + K * sd, mu - K * sd
                    z[i] = (dev[i] - mu) / sd
        sma20, sma50 = rollmean(dev, 20), rollmean(dev, 50)

        # signal markers: fade band-position z extremes
        signals = []
        for i in range(n):
            if z[i] is None:
                continue
            if z[i] >= K:
                signals.append({"date": dates[i], "type": "sell", "z": round(z[i], 2), "dev": round(dev[i], 3)})
            elif z[i] <= -K:
                signals.append({"date": dates[i], "type": "buy", "z": round(z[i], 2), "dev": round(dev[i], 3)})

        # mean-reversion backtest on NEER returns: position from yesterday's z
        rets = [0.0] + [math.log(neer[i] / neer[i - 1]) if (neer[i] and neer[i - 1]) else 0.0
                        for i in range(1, n)]
        pos, strat = 0, [0.0]
        for i in range(1, n):
            zi = z[i - 1]
            if zi is not None:
                if zi >= K:
                    pos = -1
                elif zi <= -K:
                    pos = 1
                elif abs(zi) < 0.5:
                    pos = 0
            strat.append(pos * rets[i])
        equity = [1.0]
        for r in strat[1:]:
            equity.append(equity[-1] * (1 + r))
        rsharpe = [None] * n
        W = 60
        for i in range(n):
            if i >= W:
                seg = strat[i - W + 1:i + 1]
                sd = st.pstdev(seg) or 1e-9
                rsharpe[i] = round(math.sqrt(252) * (sum(seg) / len(seg)) / sd, 2)
        peak, maxdd = equity[0], 0.0
        for v in equity:
            peak = max(peak, v); maxdd = min(maxdd, v / peak - 1)
        active = [r for r in strat[1:] if r != 0.0]
        hit = (sum(1 for r in active if r > 0) / len(active) * 100.0) if active else None
        sd_all = st.pstdev(strat[1:]) or 1e-9
        sharpe = math.sqrt(252) * (st.mean(strat[1:]) / sd_all)
        return {
            "dates": dates, "neer": neer, "devPct": dev,
            "bollinger": {"sma": sma, "upper": upper, "lower": lower, "z": z, "n": N, "k": K},
            "trend": {"sma20": sma20, "sma50": sma50},
            "signals": signals,
            "backtest": {
                "equity": [round(v, 5) for v in equity],
                "rollingSharpe": rsharpe,
                "totalReturnPct": round((equity[-1] - 1) * 100.0, 2),
                "annReturnPct": round((equity[-1] ** (252.0 / n) - 1) * 100.0, 2),
                "sharpe": round(sharpe, 2),
                "maxDrawdownPct": round(maxdd * 100.0, 2),
                "hitRatePct": round(hit, 1) if hit is not None else None,
                "nSignals": len(signals),
                "strategy": "Mean-reversion: fade band-position z-score (enter |z|≥2, exit |z|<0.5). "
                            "Detrended vs the crawling midpoint; policy slope booked separately as carry.",
            },
        }


def _corr(a: List[float], b: List[float]) -> float:
    import statistics as st
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = st.mean(a), st.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return num / (da * db) if da and db else 0.0
