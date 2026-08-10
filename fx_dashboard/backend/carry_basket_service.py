"""
Carry Basket — a deep-dive sizing monitor.

Idea (trader spec): go LONG the X highest-yielding currencies and SHORT the Y
lowest-yielding, across ALL traded EM currencies (the pricer universe) PLUS the
G10 (which are NOT in the pricer). Always show a yield rank across the combined
universe. The user specifies the longs (top-N or explicit) with USD notionals and
how many / which shorts; the tool sizes the short leg VOL-ADJUSTED to balance the
longs, and reports the book's risk + carry efficiency.

Design anchored to institutional convention (DB Harvest / Bloomberg-GSAM / JPMorgan
carry, BIS carry-to-risk, Koijen-Moskowitz-Pedersen-Vrugt "Carry"):

  YIELD / CARRY METRIC
    Rank on the 1-month FORWARD-IMPLIED yield vs USD (CIP): the tradable carry, not
    a policy/deposit rate. For NDF (restricted) names this is the NDF-implied yield
    (offshore) — the right number, since onshore rates misstate the tradable carry.
    carry_i = implied_yield_i - SOFR_1M   (annual %, the forward's carry vs USD).

  SIZING
    - dollar-neutral : short notional total = long notional total (index convention)
    - vol-neutral    : total short daily-$-vol = total long daily-$-vol (DEFAULT;
                       "volatility adjusted" per the trader). Within each leg the
                       shorts are distributed by the chosen weighting.
    Within-leg weighting: inverse-vol (each name equal $-risk; DEFAULT) or equal-notional.

  VOL
    Daily realized vol of the currency's APPRECIATION return (log-returns of USD-per-
    foreign), annualized ×√252. Default window 20d (responsive); 10/60/90d selectable.
    (RiskMetrics/JPM would use EWMA λ=0.94 ≈ 11d half-life; exposed as a window option.)

  RISK REPORTING
    Per-name sizing ignores correlation, but carry currencies co-move (global-FX-vol
    factor), so the book's TRUE daily-$-vol is reported from the FULL covariance of
    the basket's appreciation returns (signed exposures) — the honest risk number,
    which the naive per-leg sum overstates in calm regimes and understates in stress.

  EFFICIENCY
    carry-to-vol = net annual carry $ ÷ annualized book $ vol (ex-ante Sharpe proxy).
    Carry is structurally short-vol / negatively-skewed, so realized skew + max
    drawdown of the equal-weel basket proxy are shown alongside (don't read a high
    carry-to-vol as "safe").

Rate-limit discipline (shared LSEG desktop session): the yield RANK comes from ONE
batched snapshot (all spot + all 1M-point RICs) cached ~90s; vol + covariance come
from spot history fetched ONCE and cached ~2h. Nothing re-fetches history per poll.
"""
from __future__ import annotations
import logging
import math
import statistics as st
import time as _t
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from ric_config import CURRENCIES, SOFR_RICS
from discount_curve import DiscountCurve, implied_yield
from daycount import day_count as _day_count   # shared holiday-adjusted day count (on par w/ pricer)

log = logging.getLogger("carry")

# ── G10 universe (NOT in the pricer). code -> config ──
#   spot_ric / pts_ric : LSEG RICs (spot + 1M forward swap points)
#   pip_factor         : outright = spot + points / pip_factor
#   inverted           : True  → RIC quotes USD per 1 FOREIGN (EUR/GBP/AUD/NZD);
#                        reciprocate to FOREIGN-per-USD for the CIP engine.
#                        False → RIC already quotes FOREIGN per USD (JPY/CHF/CAD/NOK/SEK).
G10: Dict[str, Dict[str, Any]] = {
    "EUR": {"spot_ric": "EUR=", "pts_ric": "EUR1M=", "pip_factor": 1e4, "inverted": True,  "pair": "EURUSD"},
    "GBP": {"spot_ric": "GBP=", "pts_ric": "GBP1M=", "pip_factor": 1e4, "inverted": True,  "pair": "GBPUSD"},
    "AUD": {"spot_ric": "AUD=", "pts_ric": "AUD1M=", "pip_factor": 1e4, "inverted": True,  "pair": "AUDUSD"},
    "NZD": {"spot_ric": "NZD=", "pts_ric": "NZD1M=", "pip_factor": 1e4, "inverted": True,  "pair": "NZDUSD"},
    "JPY": {"spot_ric": "JPY=", "pts_ric": "JPY1M=", "pip_factor": 1e2, "inverted": False, "pair": "USDJPY"},
    "CHF": {"spot_ric": "CHF=", "pts_ric": "CHF1M=", "pip_factor": 1e4, "inverted": False, "pair": "USDCHF"},
    "CAD": {"spot_ric": "CAD=", "pts_ric": "CAD1M=", "pip_factor": 1e4, "inverted": False, "pair": "USDCAD"},
    "NOK": {"spot_ric": "NOK=", "pts_ric": "NOK1M=", "pip_factor": 1e4, "inverted": False, "pair": "USDNOK"},
    "SEK": {"spot_ric": "SEK=", "pts_ric": "SEK1M=", "pip_factor": 1e4, "inverted": False, "pair": "USDSEK"},
}

VOL_WINDOWS = [10, 20, 60, 90]
DEFAULT_WINDOW = 20
ANNUALIZE = math.sqrt(252.0)
SNAP_FIELDS = ["CF_BID", "CF_ASK", "CF_LAST", "VALUE", "PRIMACT_1"]

# ── User-directed sourcing for thin restricted NDFs where broker quotes genuinely
# disagree (no single "true" yield — e.g. EGP FMD-outright 22.7% vs GMGM-point 20.5%).
# Each source resolves to a forward OUTRIGHT (foreign-per-USD); the ccy's outright is
# the mean of the resolved sources. Overrides the default composite/broker chain.
#   "outright": RIC value IS the outright ({code}1MNDFOR={broker}).
#   "point"   : RIC value is a swap point; outright = spot + point/pip_factor (ccy value_mode).
CUSTOM_SOURCES: Dict[str, List[Tuple[str, str]]] = {
    "EGP": [("EGP1MNDF=GMGM", "point"), ("EGP1MNDFOR=FMD", "outright")],   # average GMGM & FMD
    "NGN": [("NGN1MNDFOR=MBGL", "outright")],                               # Martin Brokers (MBGL)
}


def _num(*vals) -> Optional[float]:
    for v in vals:
        if v is None:
            continue
        try:
            f = float(v)
            if f == f:
                return f
        except (TypeError, ValueError):
            pass
    return None


class CarryBasketService:
    def __init__(self, lseg):
        self.lseg = lseg
        self._rank_cache: Optional[Tuple[float, Dict[str, Any]]] = None
        self._hist_cache: Dict[str, Tuple[float, List[Tuple[str, float]]]] = {}
        self._sofr_cache: Optional[Tuple[float, float]] = None
        self._days_cache: Dict[str, Tuple[str, int]] = {}    # code -> (asOfIso, days)

    def _days_1m(self, code: str) -> int:
        """Today's 1M spot→value-date day count (holiday-adjusted), via the shared
        daycount module. Cached per as-of day."""
        iso = date.today().isoformat()
        c = self._days_cache.get(code)
        if c and c[0] == iso:
            return c[1]
        days = _day_count(code, 1, date.today())
        self._days_cache[code] = (iso, days)
        return days

    # ───────────────────────── universe ─────────────────────────
    def _universe(self) -> List[Dict[str, Any]]:
        """Combined EM (pricer) + G10 universe with the fields the rank needs."""
        out: List[Dict[str, Any]] = []
        for code, cfg in CURRENCIES.items():
            # NGN/EGP: composite swap-point RIC is null — the pricer derives the forward
            # from broker OUTRIGHT RICs ({code}1MNDFOR={broker}). Carry the outright RICs
            # so the rank can read the outright directly instead of faking spot (→ SOFR).
            outright_rics = ([cfg.outright_ric(1, broker=b) for b in cfg.outright_source_brokers]
                             if cfg.derive_from_outrights else [])
            # Ordered 1M-point sources: composite first, then brokers (each with its OWN
            # value_mode — e.g. MXN composite is 'outright' pesos but brokers quote 'pips').
            # The rank tries these in order so a null/absent composite self-heals via a
            # broker instead of blanking or collapsing to the USD rate. No fallback to 0.
            pts_sources = [(cfg.swap_points_ric(1), cfg.value_mode_for("composite"))]
            for b in cfg.brokers[:3]:
                pts_sources.append((cfg.broker_ric(1, b), cfg.value_mode_for(b)))
            out.append({
                "code": code, "pair": cfg.pair, "group": "EM",
                "spot_ric": cfg.spot_ric, "pts_sources": pts_sources,
                "pip_factor": cfg.pip_factor or 1.0,
                "value_mode": cfg.value_mode, "inverted": bool(cfg.inverted),
                "ndf": cfg.kind == "NDF", "outright_rics": outright_rics,
            })
        for code, g in G10.items():
            out.append({
                "code": code, "pair": g["pair"], "group": "G10",
                "spot_ric": g["spot_ric"], "pts_sources": [(g["pts_ric"], "pips")],
                "pip_factor": g["pip_factor"], "value_mode": "pips",
                "inverted": g["inverted"], "ndf": False, "outright_rics": [],
            })
        return out

    # ───────────────────────── data helpers ─────────────────────────
    def _sofr_1m(self) -> float:
        if self._sofr_cache and (_t.time() - self._sofr_cache[0]) < 300:
            return self._sofr_cache[1]
        val = 4.3
        try:
            snap = self.lseg.get_snapshot([SOFR_RICS[1]], SNAP_FIELDS)
            q = snap.get(SOFR_RICS[1]) or {}
            b, a = _num(q.get("CF_BID")), _num(q.get("CF_ASK"))
            if b is not None and a is not None:
                v = (b + a) / 2.0
            else:
                v = _num(q.get("PRIMACT_1"), q.get("CF_LAST"), q.get("VALUE"), b, a)
            if v is not None and 0 < v < 20:
                val = v
        except Exception:
            log.exception("carry: SOFR 1M snapshot failed")
        self._sofr_cache = (_t.time(), val)
        return val

    def _hist_mid(self, ric: str, days: int = 420, ttl: float = 7200) -> List[Tuple[str, float]]:
        """Cached daily (date, mid) series for an FX RIC (BID/ASK)."""
        c = self._hist_cache.get(ric)
        if c and (_t.time() - c[0]) < ttl:
            return c[1]
        start = (date.today() - timedelta(days=days)).isoformat()
        end = date.today().isoformat()
        out: List[Tuple[str, float]] = []
        try:
            h = self.lseg.get_history([ric], fields=["BID", "ASK"], interval="daily", start=start, end=end)
            for bar in (h or {}).get(ric) or []:
                dt = (bar.get("Date") or "")[:10]
                b, a = _num(bar.get("BID")), _num(bar.get("ASK"))
                m = (b + a) / 2.0 if (b is not None and a is not None) else (b if b is not None else a)
                if dt and m is not None:
                    out.append((dt, m))
            out.sort()
        except Exception:
            log.exception("carry: history failed for %s", ric)
        self._hist_cache[ric] = (_t.time(), out)
        return out

    @staticmethod
    def _outright(spot: float, pts: float, u: Dict[str, Any],
                  value_mode: Optional[str] = None) -> Optional[float]:
        """Forward outright in FOREIGN-per-USD from spot + 1M points, honoring the
        source's value_mode / the ccy's pip_factor / inverted convention. Returns None
        if the points are missing — WITHOUT points the forward would equal spot and the
        yield would collapse to the USD rate (SOFR), silently faking a ~3.6% yield.
        `value_mode` overrides the composite mode (a broker source may quote differently,
        e.g. MXN composite is 'outright' pesos but its brokers quote 'pips')."""
        if spot is None or spot == 0 or pts is None:
            return None
        pf = u["pip_factor"] or 1.0
        if u["inverted"]:
            # RIC quotes USD-per-foreign; points add in that convention, then reciprocate.
            fwd_usd_per = spot + pts / pf
            if fwd_usd_per <= 0:
                return None
            return 1.0 / fwd_usd_per
        vm = value_mode or u["value_mode"]
        add = (pts / pf) if vm == "pips" else pts
        fwd = spot + add
        return fwd if fwd > 0 else None

    @staticmethod
    def _spot_fx(spot: float, u: Dict[str, Any]) -> Optional[float]:
        """Spot in FOREIGN-per-USD (reciprocal for inverted G10 pairs)."""
        if spot is None or spot == 0:
            return None
        return (1.0 / spot) if u["inverted"] else spot

    # ───────────────────────── yield rank ─────────────────────────
    def rank(self, force: bool = False) -> Dict[str, Any]:
        """1M forward-implied yield vs USD for every EM + G10 currency, ranked desc.
        Single batched snapshot; cached ~90s to spare the shared LSEG session."""
        if not force and self._rank_cache and (_t.time() - self._rank_cache[0]) < 90:
            return self._rank_cache[1]

        uni = self._universe()
        rics: List[str] = []
        for u in uni:
            rics.append(u["spot_ric"])
            for ric, _vm in u.get("pts_sources") or []:
                rics.append(ric)
            for orr in u.get("outright_rics") or []:
                rics.append(orr)
            for cric, _typ in CUSTOM_SOURCES.get(u["code"], []):
                rics.append(cric)
        # de-dup preserving order
        rics = list(dict.fromkeys(rics))

        snap: Dict[str, Any] = {}
        try:
            snap = self.lseg.get_snapshot(rics, SNAP_FIELDS) or {}
        except Exception:
            log.exception("carry: rank snapshot failed")

        sofr = self._sofr_1m()
        # USD curves cached by day count (only a couple distinct values across the universe)
        usd_by_days: Dict[int, DiscountCurve] = {}

        def usd_curve(d: int) -> DiscountCurve:
            if d not in usd_by_days:
                usd_by_days[d] = DiscountCurve.from_ois({d: sofr})
            return usd_by_days[d]

        def mid(ric: str) -> Optional[float]:
            q = snap.get(ric) or {}
            b, a = _num(q.get("CF_BID")), _num(q.get("CF_ASK"))
            if b is not None and a is not None:
                return (b + a) / 2.0
            return _num(q.get("CF_LAST"), q.get("VALUE"), q.get("PRIMACT_1"))

        rows: List[Dict[str, Any]] = []
        for u in uni:
            s_raw = mid(u["spot_ric"])
            spot_fx = self._spot_fx(s_raw, u)
            d1m = self._days_1m(u["code"])
            # Forward outright (FOREIGN-per-USD), sourced in priority order — NEVER a
            # fallback to 0/spot. Derive-from-outright names (NGN/EGP) are flagged BECAUSE
            # their point RICs (composite AND broker) are unreliable, so their broker
            # OUTRIGHT RIC ({code}1MNDFOR={broker}) is the canonical source and comes FIRST.
            # Everyone else: composite point → broker points.
            fwd_fx = None
            src = None
            # User-directed override first (EGP = avg GMGM+FMD; NGN = Martin/MBGL).
            custom = CUSTOM_SOURCES.get(u["code"])
            if custom:
                outs = []
                for cric, typ in custom:
                    v = mid(cric)
                    if v is None:
                        continue
                    o = (v if v > 0 else None) if typ == "outright" else self._outright(s_raw, v, u)
                    if o and o > 0:
                        outs.append(o)
                if outs:
                    fwd_fx = sum(outs) / len(outs)
                    src = ("avg%d" % len(outs)) if len(outs) > 1 else "broker"
            if fwd_fx is None:
                for orr in (u.get("outright_rics") or []):
                    ov = mid(orr)
                    if ov is not None and ov > 0:
                        fwd_fx, src = ov, "outright"
                        break
            if fwd_fx is None:
                for i, (ric, vm) in enumerate(u.get("pts_sources") or []):
                    p = mid(ric)
                    if p is None:
                        continue
                    f = self._outright(s_raw, p, u, vm)
                    if f:
                        fwd_fx = f
                        src = "composite" if i == 0 else "broker"
                        break
            iy = implied_yield(fwd_fx, spot_fx, usd_curve(d1m), d1m) if (spot_fx and fwd_fx) else None
            rows.append({
                "code": u["code"], "pair": u["pair"], "group": u["group"], "ndf": u["ndf"],
                "spot": round(spot_fx, 6) if spot_fx else None,
                "days1m": d1m, "src": src,
                "impliedYield": round(iy, 4) if iy is not None else None,
                "carry": round(iy - sofr, 4) if iy is not None else None,
                "hasData": iy is not None,
            })
        ranked = sorted(rows, key=lambda r: (r["impliedYield"] is None, -(r["impliedYield"] or -1e9)))
        for i, r in enumerate(ranked):
            r["rank"] = i + 1
        res = {
            "asOf": date.today().isoformat(), "sofr1m": round(sofr, 4),
            "nWithData": sum(1 for r in ranked if r["hasData"]),
            "nTotal": len(ranked), "rank": ranked,
        }
        self._rank_cache = (_t.time(), res)
        return res

    # ───────────────────────── vol + covariance ─────────────────────────
    def _appr_returns(self, code: str, u: Dict[str, Any]) -> List[Tuple[str, float]]:
        """Daily log APPRECIATION returns (USD-per-foreign) keyed by date.
        + return = currency appreciated = gain for a long position."""
        ser = self._hist_mid(u["spot_ric"])
        # convert each level to USD-per-foreign so +move = appreciation
        lvl: List[Tuple[str, float]] = []
        for dt, s in ser:
            fx = self._spot_fx(s, u)              # foreign-per-USD
            if fx and fx > 0:
                lvl.append((dt, 1.0 / fx))        # USD-per-foreign
        rets: List[Tuple[str, float]] = []
        for i in range(1, len(lvl)):
            p0, p1 = lvl[i - 1][1], lvl[i][1]
            if p0 > 0 and p1 > 0:
                rets.append((lvl[i][0], math.log(p1 / p0)))
        return rets

    def _daily_vol(self, rets: List[float], window: int) -> Optional[float]:
        if len(rets) < window + 1:
            return None
        return st.pstdev(rets[-window:])

    def _u_for(self, code: str) -> Optional[Dict[str, Any]]:
        for u in self._universe():
            if u["code"] == code:
                return u
        return None

    def vols(self, codes: List[str], window: int = DEFAULT_WINDOW) -> Dict[str, Any]:
        """Per-name daily vol% (annualized) + downside percentiles, for a code list."""
        window = window if window in VOL_WINDOWS else DEFAULT_WINDOW
        out: Dict[str, Any] = {}
        for code in codes:
            u = self._u_for(code)
            if not u:
                out[code] = {"error": "unknown"}
                continue
            rets = [r for _, r in self._appr_returns(code, u)]
            sd = self._daily_vol(rets, window)
            if sd is None:
                out[code] = {"error": "insufficient history", "n": len(rets)}
                continue
            w = sorted(rets[-window:])
            def pct(p):
                k = max(0, min(len(w) - 1, int(p * len(w))))
                return w[k]
            out[code] = {
                "dailyVolPct": round(sd * 100.0, 4),
                "annVolPct": round(sd * 100.0 * ANNUALIZE, 3),
                "histDown95Pct": round(abs(pct(0.05)) * 100.0, 4),
                "histDown99Pct": round(abs(pct(0.01)) * 100.0, 4),
                "n": len(w), "window": window,
            }
        return out

    def _covariance(self, codes: List[str], window: int) -> Tuple[List[str], List[List[float]], Dict[str, List[float]]]:
        """Sample covariance of daily appreciation returns over the common last-`window`
        overlapping dates. Returns (codes_used, cov_matrix, per_code_return_window)."""
        series: Dict[str, Dict[str, float]] = {}
        for code in codes:
            u = self._u_for(code)
            if not u:
                continue
            series[code] = dict(self._appr_returns(code, u))
        # common dates across all requested codes with data
        good = [c for c in codes if series.get(c)]
        if not good:
            return [], [], {}
        common = set.intersection(*[set(series[c].keys()) for c in good]) if good else set()
        dates = sorted(common)[-window:]
        if len(dates) < 5:
            return good, [], {}
        vecs = {c: [series[c][d] for d in dates] for c in good}
        n = len(dates)
        means = {c: sum(vecs[c]) / n for c in good}
        cov = [[0.0] * len(good) for _ in good]
        for i, ci in enumerate(good):
            for j, cj in enumerate(good):
                cov[i][j] = sum((vecs[ci][k] - means[ci]) * (vecs[cj][k] - means[cj]) for k in range(n)) / n
        return good, cov, vecs

    # ───────────────────────── basket sizing ─────────────────────────
    def basket(self, longs: List[Dict[str, Any]], short_codes: List[str],
               sizing_mode: str = "vol_neutral", weighting: str = "inverse_vol",
               window: int = DEFAULT_WINDOW) -> Dict[str, Any]:
        """Size the short leg to balance user-specified longs.

        longs: [{"code": str, "notionalUsd": float}]  (USD notionals the user wants long)
        short_codes: [str]                              (which currencies to short)
        Returns per-leg legs with notionals, per-name + book daily-$-vol (full covariance),
        net carry, and carry-to-vol.
        """
        window = window if window in VOL_WINDOWS else DEFAULT_WINDOW
        sizing_mode = sizing_mode if sizing_mode in ("vol_neutral", "dollar_neutral") else "vol_neutral"
        weighting = weighting if weighting in ("inverse_vol", "equal_notional") else "inverse_vol"

        rk = self.rank()
        ymap = {r["code"]: r for r in rk["rank"]}
        sofr = rk["sofr1m"]

        long_codes = [l["code"] for l in longs]
        all_codes = long_codes + [c for c in short_codes if c not in long_codes]
        vmap = self.vols(all_codes, window)

        def vol_of(code):
            v = vmap.get(code) or {}
            return v.get("dailyVolPct")

        def dn(code, key):
            return (vmap.get(code) or {}).get(key)

        # ── long leg ──
        long_legs = []
        long_notional = 0.0
        long_dvol = 0.0     # daily $ vol (per-name sum, corr-blind)
        for l in longs:
            code = l["code"]
            notl = float(l.get("notionalUsd") or 0.0)
            vp = vol_of(code)
            dv = (notl * vp / 100.0) if vp else None
            long_notional += notl
            if dv:
                long_dvol += dv
            long_legs.append({
                "code": code, "side": "long", "pair": (ymap.get(code) or {}).get("pair"),
                "notionalUsd": round(notl, 0),
                "dailyVolPct": vp, "dailyVolUsd": round(dv, 0) if dv else None,
                "histDown95Pct": dn(code, "histDown95Pct"), "histDown99Pct": dn(code, "histDown99Pct"),
                "impliedYield": (ymap.get(code) or {}).get("impliedYield"),
                "carry": (ymap.get(code) or {}).get("carry"),
                "rank": (ymap.get(code) or {}).get("rank"),
            })

        # ── short leg sizing ──
        # target: dollar-neutral → short notional total = long notional total
        #         vol-neutral    → short daily-$-vol total = long daily-$-vol total
        sc = [c for c in short_codes if vol_of(c)]
        short_legs = []
        if sc:
            if sizing_mode == "dollar_neutral":
                # distribute long_notional across shorts by weighting
                if weighting == "inverse_vol":
                    inv = {c: 1.0 / vol_of(c) for c in sc}
                    tot = sum(inv.values())
                    for c in sc:
                        notl = long_notional * inv[c] / tot
                        short_legs.append((c, notl))
                else:  # equal_notional
                    for c in sc:
                        short_legs.append((c, long_notional / len(sc)))
            else:  # vol_neutral → total short $vol = long_dvol
                if weighting == "inverse_vol":
                    # equal $-vol per short → each contributes long_dvol/N
                    per = long_dvol / len(sc)
                    for c in sc:
                        vp = vol_of(c)
                        notl = per / (vp / 100.0) if vp else 0.0
                        short_legs.append((c, notl))
                else:  # equal_notional but scaled so TOTAL short $vol = long_dvol
                    sum_vp = sum(vol_of(c) / 100.0 for c in sc)
                    base = long_dvol / sum_vp if sum_vp else 0.0  # common notional
                    for c in sc:
                        short_legs.append((c, base))

        short_notional = 0.0
        short_dvol = 0.0
        short_out = []
        for c, notl in short_legs:
            vp = vol_of(c)
            dv = (notl * vp / 100.0) if vp else None
            short_notional += notl
            if dv:
                short_dvol += dv
            short_out.append({
                "code": c, "side": "short", "pair": (ymap.get(c) or {}).get("pair"),
                "notionalUsd": round(notl, 0),
                "dailyVolPct": vp, "dailyVolUsd": round(dv, 0) if dv else None,
                "histDown95Pct": dn(c, "histDown95Pct"), "histDown99Pct": dn(c, "histDown99Pct"),
                "impliedYield": (ymap.get(c) or {}).get("impliedYield"),
                "carry": (ymap.get(c) or {}).get("carry"),
                "rank": (ymap.get(c) or {}).get("rank"),
            })

        # ── book risk from FULL covariance (signed $ exposures) ──
        legs_all = long_legs + short_out
        exp = {}   # code -> signed $ exposure (+long / -short)
        for lg in long_legs:
            exp[lg["code"]] = exp.get(lg["code"], 0.0) + (lg["notionalUsd"] or 0.0)
        for lg in short_out:
            exp[lg["code"]] = exp.get(lg["code"], 0.0) - (lg["notionalUsd"] or 0.0)
        codes_used, cov, _ = self._covariance(list(exp.keys()), window)
        book_dvol = None
        gross_dvol = long_dvol + short_dvol
        diversification = None
        if codes_used and cov:
            w = [exp.get(c, 0.0) for c in codes_used]
            var = 0.0
            for i in range(len(codes_used)):
                for j in range(len(codes_used)):
                    var += w[i] * w[j] * cov[i][j]
            if var > 0:
                book_dvol = math.sqrt(var)   # daily $ vol (returns are in %/1.0 units → $)
                if gross_dvol > 0:
                    diversification = round(1.0 - book_dvol / gross_dvol, 3)

        # ── carry: net annual $ carry of the forward book ──
        net_carry_usd = 0.0
        for lg in legs_all:
            c = lg["carry"]
            if c is None:
                continue
            sign = 1.0 if lg["side"] == "long" else -1.0
            net_carry_usd += sign * (lg["notionalUsd"] or 0.0) * (c / 100.0)

        ann_book_vol = book_dvol * ANNUALIZE if book_dvol else None
        carry_to_vol = (net_carry_usd / ann_book_vol) if (ann_book_vol and ann_book_vol > 0) else None

        return {
            "sizingMode": sizing_mode, "weighting": weighting, "window": window,
            "sofr1m": sofr,
            "longs": long_legs, "shorts": short_out,
            "longNotionalUsd": round(long_notional, 0),
            "shortNotionalUsd": round(short_notional, 0),
            "longDailyVolUsd": round(long_dvol, 0) if long_dvol else None,
            "shortDailyVolUsd": round(short_dvol, 0) if short_dvol else None,
            "grossDailyVolUsd": round(gross_dvol, 0) if gross_dvol else None,
            "bookDailyVolUsd": round(book_dvol, 0) if book_dvol else None,
            "bookAnnVolUsd": round(ann_book_vol, 0) if ann_book_vol else None,
            "diversification": diversification,
            "netCarryUsdPerYr": round(net_carry_usd, 0),
            "carryToVol": round(carry_to_vol, 3) if carry_to_vol is not None else None,
            "missingVol": [c for c in all_codes if not vol_of(c)],
        }
