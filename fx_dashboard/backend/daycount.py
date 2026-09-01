"""
FX value-date day counts — holiday-adjusted, on par with the pricer's IPA calendar.

One shared source of truth for "how many calendar days from spot to the tenor's value
date" for a given currency AS OF a given date. Used by:
  - the Carry Basket rank (1M day count per currency), and
  - the FX pricer's HISTORICAL implied-yield series (per-bar day count) — a flat or
    weekend-only count mis-levels the historical IY by up to ~25bp on bars whose
    spot→VD window straddles a holiday (e.g. SGD around the Aug National Day).

Convention (matches IPA / the DF engine): spot = T+`lag` GOOD business days (good =
local business weekday — Fri-Sat weekend markets handled — and not a holiday in the
USD calendar NOR the currency's local calendar); value date = spot + N months, then
TRUE modified-following (forward, else backward if the roll leaves the month).
`lag` = 2 (T+2) except the T+1 names (CAD/TRY/RUB/PHP), verified vs IPA startDate.

Requires the `holidays` package; without it, falls back to a fixed weekend-ish count
(the pre-existing behaviour) so the app still runs.
"""
from __future__ import annotations
import calendar as _cal
import datetime as _dt
from datetime import date, timedelta
from typing import Dict, List, Optional

try:
    import holidays as _holidays
except Exception:                          # pragma: no cover
    _holidays = None

# Currency → `holidays` calendar for the LOCAL leg (USD is always added). EUR uses
# the ECB/TARGET financial calendar. Codes cover the pricer EM universe + G10.
_CCY_CAL: Dict[str, str] = {
    "TWD": "TW", "KRW": "KR", "INR": "IN", "IDR": "ID", "PHP": "PH", "CNY": "CN",
    "MYR": "MY", "NGN": "NG", "EGP": "EG", "CLP": "CL", "COP": "CO", "CNH": "CN",
    "SGD": "SG", "HKD": "HK", "THB": "TH", "MXN": "MX", "ZAR": "ZA", "TRY": "TR",
    "CZK": "CZ", "ILS": "IL", "RON": "RO", "PLN": "PL", "HUF": "HU", "KZT": "KZ",
    "RUB": "RU", "UGX": "UG", "MUR": "MU", "BWP": "BW", "SAR": "SA", "AED": "AE",
    "MAD": "MA", "TND": "TN", "QAR": "QA",
    # LatAm/Asia names present in client-flow exports but outside the pricer universe
    # (Client Flow tab holiday panels; harmless here — the pricer never asks for them).
    "BRL": "BR", "PEN": "PE", "ARS": "AR", "VND": "VN",
    "GBP": "GB", "AUD": "AU", "NZD": "NZ", "JPY": "JP", "CHF": "CH", "CAD": "CA",
    "NOK": "NO", "SEK": "SE",
}
# T+1 settlement vs USD (verified against the pricer's IPA startDate). Others T+2.
_SPOT_LAG: Dict[str, int] = {"CAD": 1, "TRY": 1, "RUB": 1, "PHP": 1}

# Markets whose LOCAL weekend is Friday-Saturday. A good settlement day for the
# USD cross must be a business day in BOTH calendars, so these effectively
# settle Mon-Thu (local Fri ∪ US Sat/Sun all excluded). AED moved to a
# Sat-Sun-style weekend in 2022 and stays on the default.
_FRI_SAT_WEEKEND = {"SAR", "QAR", "EGP", "ILS"}

# Weekend-ish fallback (calendar-days) when the holidays package is unavailable.
_FALLBACK: Dict[int, int] = {1: 31, 2: 61, 3: 92, 6: 183, 9: 273, 12: 365, 18: 548, 24: 730}

_cal_cache: Dict[str, object] = {}
_us_cache: List[object] = [None]
_years_cache: List[object] = [None]


def _years():
    if _years_cache[0] is None:
        y = date.today().year
        _years_cache[0] = list(range(y - 11, y + 2))  # covers up to 10Y history + forward
    return _years_cache[0]


def _us():
    if _us_cache[0] is None and _holidays is not None:
        try:
            _us_cache[0] = _holidays.country_holidays("US", years=_years())
        except Exception:
            _us_cache[0] = None
    return _us_cache[0]


def _local(code: str):
    if code in _cal_cache:
        return _cal_cache[code]
    c = None
    if _holidays is not None:
        try:
            if code == "EUR":
                c = _holidays.financial_holidays("ECB", years=_years())
            else:
                iso = _CCY_CAL.get(code)
                if iso:
                    c = _holidays.country_holidays(iso, years=_years())
        except Exception:
            c = None
    _cal_cache[code] = c
    return c


def _fallback(months: float) -> int:
    m = int(round(months))
    return _FALLBACK.get(m, max(1, int(round(months * 30.4))))


def day_count(code: str, months, as_of: date) -> int:
    """Holiday-adjusted spot→value-date calendar-day count for `code`, `months` months,
    as of `as_of`. Falls back to a fixed count if the holidays package is unavailable
    or months is not a whole number (weeklies handled by the caller's own logic)."""
    if _holidays is None or months is None or months <= 0 or months != int(months):
        return _fallback(months if months else 1)
    months = int(months)
    us, loc = _us(), _local(code)
    wk_local = (4, 5) if code in _FRI_SAT_WEEKEND else (5, 6)

    def good(d: date) -> bool:
        # union calendar: local weekend ∪ US Sat/Sun ∪ both holiday lists
        if d.weekday() in wk_local or d.weekday() >= 5:
            return False
        if us is not None and d in us:
            return False
        if loc is not None and d in loc:
            return False
        return True

    def add_biz(d: date, n: int) -> date:
        while n > 0:
            d += timedelta(days=1)
            if good(d):
                n -= 1
        return d

    def mod_foll(d: date) -> date:
        # TRUE modified-following: roll forward; if that leaves the month,
        # roll BACKWARD from the original date instead (previously this was
        # plain following, overshooting month-end value dates by 1-3 days).
        rolled = d
        while not good(rolled):
            rolled += timedelta(days=1)
        if rolled.month != d.month or rolled.year != d.year:
            rolled = d
            while not good(rolled):
                rolled -= timedelta(days=1)
        return rolled

    try:
        spot = add_biz(as_of, _SPOT_LAG.get(code, 2))
        y, m = spot.year, spot.month + months
        while m > 12:
            y += 1
            m -= 12
        vd = mod_foll(_dt.date(y, m, min(spot.day, _cal.monthrange(y, m)[1])))
        d = (vd - spot).days
        return d if d > 0 else _fallback(months)
    except Exception:
        return _fallback(months)


def day_count_map(code: str, months, iso_dates: List[str]) -> Dict[str, int]:
    """{iso → day_count} for a list of as-of ISO dates (per-bar historical day counts)."""
    out: Dict[str, int] = {}
    for iso in iso_dates:
        try:
            out[iso] = day_count(code, months, date.fromisoformat(iso[:10]))
        except Exception:
            pass
    return out
