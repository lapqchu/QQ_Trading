"""
Discount-factor (OIS) curve engine — pricing backbone.

Goal: replace ad-hoc single-tenor covered-interest-parity (CIP) math with a
consistent discount-factor framework, so spot-start implied yields, forward-
forward yields (custom dates / IMM rolls), and (later) turn-of-period
clean/dirty all read off ONE object: a discount-factor curve.

Convention (matches the rest of the app):
  Pair quoted as X = QUOTE-ccy per 1 USD (e.g. USDINR = INR per USD).
  Money-market simple interest, rates in percent. The USD/SOFR leg is ALWAYS
  Act/360 (SOFR's actual quote basis). The DISPLAYED local yield is annualised
  on the currency's configured money-market basis (`basis` param — 365 for
  Act/365-fixed markets like SGD/THB/INR, else 360; see ric_config.iy_basis).
  The DF solve itself is basis-free; basis only scales the displayed rate
  (exact identity: iy_b = iy_360 * b/360).

CIP:                F / S = DF_usd(d) / DF_ccy(d)
  => DF_ccy(d)  = DF_usd(d) * S / F(d)
  => ccy implied zero:  i_ccy(d) = (1/DF_ccy(d) - 1) * basis/d * 100
  => USD DF from OIS:    DF_usd(d) = 1 / (1 + sofr(d)/100 * d/360)   [d <= ~1Y]
     Beyond ~1Y (18M/2Y) the quoted par OIS rate pays ANNUAL Act/360 coupons:
     DF is bootstrapped from 1 = r*sum(delta_i*DF(t_i)) + (1+r*delta_n)*DF(t_n)
     using the already-built shorter nodes (treating the par rate as a simple
     zero there understates the 2Y zero by ~8bp at 4% rates).

Forward-forward ccy zero over [d_n, d_f] (near->far value dates):
  i_ff = ( DF_ccy(d_n)/DF_ccy(d_f) - 1 ) * basis/(d_f - d_n) * 100

v1 scope + honest limits:
  - USD leg uses the OIS curve INTERPOLATED to the exact day count. DF
    interpolation is LOG-LINEAR in days (arb-free, monotone), the
    market-standard choice.
  - No turn/meeting-date jumps yet; those layer on as dated DF steps (see
    turn_methodology_memo). This module is intentionally pure + dependency-free
    so it can be unit-tested and reused by market_service without side effects.
"""
from __future__ import annotations
import math
from bisect import bisect_left
from typing import Dict, List, Optional, Sequence, Tuple


def _simple_df(rate_pct: float, days: float) -> float:
    """Money-market simple-interest discount factor (Act/360)."""
    return 1.0 / (1.0 + (rate_pct / 100.0) * (days / 360.0))


class DiscountCurve:
    """A log-linear-in-days discount-factor curve built from zero DFs at nodes."""

    def __init__(self, nodes: Sequence[Tuple[float, float]]):
        # nodes: [(days, df), ...] with days > 0, df in (0, 1]. Sorted, deduped.
        pts = sorted((float(d), float(v)) for d, v in nodes if d and d > 0 and v and v > 0)
        # dedup by day
        clean: List[Tuple[float, float]] = []
        for d, v in pts:
            if clean and abs(clean[-1][0] - d) < 1e-9:
                continue
            clean.append((d, v))
        if not clean:
            raise ValueError("DiscountCurve needs at least one positive node")
        self._days = [d for d, _ in clean]
        self._lndf = [math.log(v) for _, v in clean]

    @classmethod
    def from_ois(cls, rate_by_days: Dict[float, float]) -> "DiscountCurve":
        """Build from OIS/SOFR par rates (percent) keyed by day count.
        Nodes <= ~1Y: simple-interest DF (SOFR OIS is single-payment there —
        exact). Longer nodes (18M/2Y): the quoted par rate pays ANNUAL Act/360
        coupons, so DF is bootstrapped from the par equation using the shorter
        nodes already built."""
        items = sorted((float(d), float(r)) for d, r in rate_by_days.items()
                       if d and d > 0 and r is not None)
        nodes = [(d, _simple_df(r, d)) for d, r in items if d <= 370.0]
        long_nodes = [(d, r) for d, r in items if d > 370.0]
        if long_nodes and not nodes:
            # no short anchors to discount coupons against — degrade to simple
            # rather than fabricating a coupon curve (flagged by construction:
            # a single-node long curve is already an approximation)
            return cls([(d, _simple_df(r, d)) for d, r in long_nodes])
        for d, r in long_nodes:
            partial = cls(nodes)
            rr = r / 100.0
            # annual coupon dates 365, 730, ... ; a stub < ~1M folds into the
            # final period (matches how a 13M-style tail is quoted)
            coupons: List[float] = []
            t = 365.0
            while t < d - 30.0:
                coupons.append(t)
                t += 365.0
            pv, t_prev = 0.0, 0.0
            for tc in coupons:
                pv += rr * ((tc - t_prev) / 360.0) * partial.df(tc)
                t_prev = tc
            df_d = (1.0 - pv) / (1.0 + rr * ((d - t_prev) / 360.0))
            nodes.append((d, df_d))
        return cls(nodes)

    def df(self, days: float) -> float:
        """DF at an arbitrary day count via log-linear interpolation.
        Flat zero-rate extrapolation beyond the last node; clamp before first."""
        days = float(days)
        ds, ln = self._days, self._lndf
        if days <= ds[0]:
            # extrapolate flat forward rate from origin->first node
            r0 = ln[0] / ds[0]  # ln(df)/day slope from (0,ln 1=0)
            return math.exp(r0 * days)
        if days >= ds[-1]:
            # flat instantaneous-forward extrapolation off the last segment
            if len(ds) >= 2:
                slope = (ln[-1] - ln[-2]) / (ds[-1] - ds[-2])
            else:
                slope = ln[-1] / ds[-1]
            return math.exp(ln[-1] + slope * (days - ds[-1]))
        i = bisect_left(ds, days)
        d0, d1 = ds[i - 1], ds[i]
        l0, l1 = ln[i - 1], ln[i]
        w = (days - d0) / (d1 - d0)
        return math.exp(l0 + w * (l1 - l0))

    def zero(self, days: float, basis: float = 360.0) -> float:
        """Simple-interest zero rate (percent) implied by DF(days), annualised
        on `basis` (360 default; pass the ccy's MM basis for displayed yields)."""
        d = float(days)
        if d <= 0:
            return 0.0
        return (1.0 / self.df(d) - 1.0) * basis / d * 100.0


def ccy_df(fwd_outright: float, spot: float, usd_df: float) -> Optional[float]:
    """DF_ccy(d) = DF_usd(d) * S / F(d).  (X = quote-ccy per 1 USD.)"""
    if not fwd_outright or not spot or usd_df is None:
        return None
    return usd_df * spot / fwd_outright


def implied_yield(fwd_outright: float, spot: float, usd_curve: DiscountCurve,
                  days: float, basis: float = 360.0) -> Optional[float]:
    """Spot-start ccy implied zero (percent) from the forward and the USD DF
    curve, annualised on the ccy's MM `basis` (365 for Act/365 markets)."""
    if days is None or days <= 0 or not spot or not fwd_outright:
        return None
    dfc = ccy_df(fwd_outright, spot, usd_curve.df(days))
    if not dfc or dfc <= 0:
        return None
    return (1.0 / dfc - 1.0) * basis / days * 100.0


def fwd_fwd_yield(fwd_near: float, days_near: float,
                  fwd_far: float, days_far: float,
                  spot: float, usd_curve: DiscountCurve,
                  basis: float = 360.0) -> Optional[float]:
    """Forward-forward ccy zero (percent) over [days_near, days_far] from two
    forward outrights + the USD DF curve. i_ff = (DFn/DFf - 1)*basis/(df-dn)*100."""
    if None in (fwd_near, fwd_far, days_near, days_far, spot):
        return None
    if days_far <= days_near:
        return None
    dfn = ccy_df(fwd_near, spot, usd_curve.df(days_near))
    dff = ccy_df(fwd_far, spot, usd_curve.df(days_far))
    if not dfn or not dff or dff <= 0:
        return None
    return (dfn / dff - 1.0) * basis / (days_far - days_near) * 100.0


# ─────────────────────────────────────────────────────────────
# Self-test: run `python3 discount_curve.py`
# ─────────────────────────────────────────────────────────────
def _selftest() -> None:
    ok = True

    def chk(name, got, exp, tol=1e-6):
        nonlocal ok
        good = got is not None and abs(got - exp) <= tol
        ok = ok and good
        print(f"  [{'PASS' if good else 'FAIL'}] {name}: got={got} exp={exp}")

    # A flat 4% OIS curve → DF-implied zero == 4% exactly at nodes; log-linear DF
    # interpolation between nodes wobbles <1bp on a flat simple curve (a known,
    # acceptable interpolation artifact — the market-standard no-arb choice).
    tenors = {31: 4.0, 92: 4.0, 184: 4.0, 366: 4.0}
    curve = DiscountCurve.from_ois(tenors)
    chk("flat-curve zero @92d (node, exact)", curve.zero(92), 4.0, 1e-6)
    chk("flat-curve zero @60d interp (<1bp)", curve.zero(60), 4.0, 0.01)

    spot = 90.0
    # DF_ccy target for a ccy zero y at d: 1/(1 + y*d/360). Build the forward
    # CONSISTENTLY with the engine's own USD DF: F = spot*DF_usd(d)/DF_ccy(d).
    # implied_yield must then round-trip y exactly, independent of USD interpolation.
    def dfc_target(y, d):
        return 1.0 / (1.0 + y / 100.0 * d / 360.0)
    d = 92
    F = spot * curve.df(d) / dfc_target(7.0, d)
    chk("implied_yield round-trips 7%", implied_yield(F, spot, curve, d), 7.0, 1e-6)

    # Fwd-fwd: engine must equal the analytic DF-ratio forward. (Note: on a FLAT
    # simple-zero curve the forward is NOT the zero rate — simple interest doesn't
    # preserve flatness — so we assert against the exact DF-ratio value, not 7%.)
    dn, df_ = 90, 180
    yc_n, yc_f = 7.0, 6.5
    Fn = spot * curve.df(dn) / dfc_target(yc_n, dn)
    Ff = spot * curve.df(df_) / dfc_target(yc_f, df_)
    dfc_n, dfc_f = dfc_target(yc_n, dn), dfc_target(yc_f, df_)
    expected_ff = (dfc_n / dfc_f - 1.0) * 360.0 / (df_ - dn) * 100.0
    chk("fwd_fwd == analytic DF-ratio forward",
        fwd_fwd_yield(Fn, dn, Ff, df_, spot, curve), expected_ff, 1e-9)

    # Basis conversion is an exact scaling: iy(365) == iy(360) * 365/360.
    iy360 = implied_yield(F, spot, curve, d)
    iy365 = implied_yield(F, spot, curve, d, basis=365.0)
    chk("basis 365 = basis 360 × 365/360", iy365, iy360 * 365.0 / 360.0, 1e-9)

    # Annual-compounding bootstrap beyond 1Y: on a flat 4% par curve the 2Y
    # zero must sit ABOVE the simple-interest reading (~8bp at 4%), and the
    # bootstrapped DF must reprice the par swap to 1 exactly.
    curve2 = DiscountCurve.from_ois({92: 4.0, 184: 4.0, 366: 4.0, 548: 4.0, 730: 4.0})
    z2y = curve2.zero(730)
    good2 = 4.04 < z2y < 4.12
    print(f"  [{'PASS' if good2 else 'FAIL'}] 2Y zero reflects annual compounding: {z2y:.4f}% (simple would be 4.00)")
    ok = ok and good2
    rr = 0.04
    par = rr * (365.0 / 360.0) * curve2.df(365) + (1.0 + rr * (365.0 / 360.0)) * curve2.df(730)
    chk("2Y par OIS reprices to 1", par, 1.0, 1e-9)
    chk("<=1Y nodes stay simple-exact", curve2.zero(184), 4.0, 1e-6)

    # Monotonic DF (no-arb): df must strictly decrease with days.
    mono = all(curve.df(d) > curve.df(d + 10) for d in (10, 100, 300, 700))
    print(f"  [{'PASS' if mono else 'FAIL'}] DF strictly decreasing")
    ok = ok and mono

    print("ALL PASS" if ok else "FAILURES ABOVE")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    _selftest()
