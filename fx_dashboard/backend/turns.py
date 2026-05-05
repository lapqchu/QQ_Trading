"""
Turn-date calendar generator.

A "turn" in FX swap / NDF markets is a calendar boundary across which USD
funding becomes special and the 1-day implied yield gaps. The "turn date"
we report here is the VALUE DATE corresponding to the first business day
of the new period, plus the standard T+2 spot offset — i.e., the first
FX swap value date that holds USD across the calendar boundary.

For year-end 2026 (boundary Dec 31, 2026 → Jan 1, 2027 NYD):
  • First NY biz day post-boundary: Jan 4, 2027 (Mon, after NYD + weekend)
  • + T+2 biz days = Jan 6, 2027 ← turn value date
  • A swap with VD ≥ Jan 6, 2027 holds USD across Jan 1 → carries the turn premium.
  • A swap with VD ≤ Jan 5, 2027 does not.

This convention matches the "spot-vs-spot+1 ON funding" deal that interbank
desks use to price the YE turn:
  • Last pre-YE-trade spot VD: Jan 5 (Dec 31 trade + T+2 with NYD + weekend)
  • First post-YE-trade spot VD: Jan 6 (Jan 4 trade + T+2)
  • The ON deal between Jan 5 and Jan 6 IS the turn ON funding.

Per-currency rules live on `CurrencyConfig.turn_types`. Defaults:
  most NDFs / deliverables : ["YE", "QE"]
  INR                      : ["YE", "QE", "ME"]   (RBI / FBIL: month-ends matter)
  TWD                      : ["YE"]               (per user)
  KRW                      : ["YE", "QE", "LUNAR"](Lunar New Year)

LIMITATIONS:
  • Holiday calendar is approximate: NYD + Christmas only. Per-ccy holidays
    (TPE Lunar week, KRW Seollal, INR Republic Day, etc.) are NOT modeled.
    For most ccys this gets the turn VD within ±1 biz day of the actual
    interbank-quoted turn VD; for KRW LUNAR turn the actual Korean holiday
    block (typically 3 trading days around Seollal) can push the real
    post-LNY first biz day later than our approximation by 1-2 biz days.
  • Spot offset is T+2 by default. CAD/MXN are T+1 in deliverable spot;
    those would need an override but are not currently overridden.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, List


# Universal NY-side FX-settlement holidays for 2024-2030. NYD and Christmas
# are universally non-settlement; other US bank holidays (MLK, Presidents
# Day, Memorial, Juneteenth, Independence, Labor, Thanksgiving) often
# still see FX cash settlement, so we conservatively skip only the
# universally-closed days. Add per-ccy holidays here over time.
def _build_us_holidays() -> set:
    out = set()
    for y in range(2024, 2031):
        out.add(date(y, 1, 1))    # New Year's Day
        out.add(date(y, 12, 25))  # Christmas
    return out


_US_HOLIDAYS: set = _build_us_holidays()


# Pre-computed Lunar New Year dates (KRW-relevant) — sourced from public
# almanacs. Cover spot+24M from 2026 onward; extend annually as needed.
_LUNAR_NEW_YEAR: dict[int, date] = {
    2026: date(2026, 2, 17),
    2027: date(2027, 2, 6),
    2028: date(2028, 1, 26),
    2029: date(2029, 2, 13),
    2030: date(2030, 2, 3),
}


@dataclass
class Turn:
    iso: str       # YYYY-MM-DD (the post-boundary value date)
    type: str      # YE | QE | ME | LUNAR
    label: str     # human-readable label of the period being closed
                   # (e.g. "YE 2026" — turn VD itself is in Jan 2027)

    def to_dict(self) -> dict:
        return {"date": self.iso, "type": self.type, "label": self.label}


def _is_biz_day(d: date) -> bool:
    return d.weekday() < 5 and d not in _US_HOLIDAYS


def _first_biz_at_or_after(d: date) -> date:
    while not _is_biz_day(d):
        d += timedelta(days=1)
    return d


def _add_biz_days(d: date, n: int) -> date:
    for _ in range(n):
        d += timedelta(days=1)
        while not _is_biz_day(d):
            d += timedelta(days=1)
    return d


def _post_boundary_vd(period_first_day: date, spot_offset: int) -> date:
    """First FX swap VD that holds USD across the period boundary.

    period_first_day: first calendar day of the new period
                      (Jan 1 for YE, Apr 1 for Q1, May 1 for ME-Apr,
                       LNY date for LUNAR, etc.).
    spot_offset:      business-day offset from trade to value (T+2 standard).

    Returns first biz day on-or-after period_first_day, plus spot_offset
    biz days. Example: period_first_day = Jan 1, 2027, spot_offset = 2
    →  first_biz_at_or_after(Jan 1, 2027) = Jan 4 (Mon, after NYD + wkend)
    →  + 2 biz days = Jan 6 (Wed) — the YE-2026 turn value date.
    """
    first_biz = _first_biz_at_or_after(period_first_day)
    return _add_biz_days(first_biz, spot_offset)


def _next_month_first_day(y: int, m: int) -> date:
    """First calendar day of the month after (y, m)."""
    if m == 12:
        return date(y + 1, 1, 1)
    return date(y, m + 1, 1)


def generate_turns(turn_types: Iterable[str], spot: date,
                   horizon_months: int = 24,
                   spot_offset: int = 2) -> List[Turn]:
    """
    Generate concrete turn-date VDs from `spot` through `spot + horizon_months`.

    turn_types:    subset of {"YE", "QE", "ME", "LUNAR"}.
    spot:          spot value date (turns are filtered to be > spot).
    horizon_months: how far forward to generate; 24 matches the dashboard's
                    max_display_m=24.
    spot_offset:   business days between trade date and value date (T+2 std).

    Returns turns sorted by date, deduped (year-end IS quarter-end IS
    month-end — keep most-specific type per date with priority
    YE > LUNAR > QE > ME). Each turn's .iso is the post-boundary VALUE DATE.
    """
    types = set(turn_types)
    horizon_end = date(spot.year + (spot.month + horizon_months - 1) // 12,
                       ((spot.month + horizon_months - 1) % 12) + 1, 1)

    by_date: dict[date, Turn] = {}
    priority = {"YE": 4, "LUNAR": 3, "QE": 2, "ME": 1}

    def _add(d: date, t_type: str, label: str):
        if d <= spot or d >= horizon_end:
            return
        existing = by_date.get(d)
        if existing is None or priority[t_type] > priority[existing.type]:
            by_date[d] = Turn(iso=d.isoformat(), type=t_type, label=label)

    # ── Year-end and quarter-end ─────────────────────────────────────
    # When QE is enabled, YE is always also added (Q4-end IS year-end).
    if "YE" in types or "QE" in types:
        y = spot.year
        while date(y, 1, 1) < horizon_end:
            for end_m in (3, 6, 9, 12):
                first_next = _next_month_first_day(y, end_m)
                vd = _post_boundary_vd(first_next, spot_offset)
                is_year_end = (end_m == 12)
                # YE always counts when QE is enabled (Q4-end IS YE).
                should_add = (
                    (is_year_end and ("YE" in types or "QE" in types)) or
                    (not is_year_end and "QE" in types)
                )
                if not should_add:
                    continue
                t_type = "YE" if is_year_end else "QE"
                if is_year_end:
                    label = f"YE {y}"
                else:
                    label = f"QE {date(y, end_m, 1).strftime('%b %Y')}"
                _add(vd, t_type, label)
            y += 1

    # ── Month-end (INR only, by default) ─────────────────────────────
    if "ME" in types:
        y, m = spot.year, spot.month
        while True:
            first_next = _next_month_first_day(y, m)
            if first_next >= horizon_end:
                break
            vd = _post_boundary_vd(first_next, spot_offset)
            if vd > spot and vd < horizon_end:
                _add(vd, "ME", f"ME {date(y, m, 1).strftime('%b %Y')}")
            m += 1
            if m > 12:
                m = 1
                y += 1

    # ── Lunar New Year (KRW) ─────────────────────────────────────────
    if "LUNAR" in types:
        for y, lny in _LUNAR_NEW_YEAR.items():
            if y < spot.year - 1 or y > spot.year + (horizon_months // 12) + 1:
                continue
            vd = _post_boundary_vd(lny, spot_offset)
            _add(vd, "LUNAR", f"Lunar {y}")

    return sorted(by_date.values(), key=lambda t: t.iso)


def turn_types_for(cfg) -> List[str]:
    """Resolve the turn-type list for a CurrencyConfig with a sensible default.
    Reads `cfg.turn_types` if present; otherwise picks a default based on kind
    and currency code."""
    explicit = getattr(cfg, "turn_types", None)
    if explicit:
        return list(explicit)
    code = getattr(cfg, "code", "")
    # Per-ccy defaults — overridable by setting turn_types on the config.
    if code == "INR":
        return ["YE", "QE", "ME"]    # INR NDF: month-ends matter (RBI / FBIL)
    if code == "TWD":
        return ["YE"]                 # TWD NDF: only year-end (per user)
    if code == "KRW":
        return ["YE", "QE", "LUNAR"]  # KRW NDF: year-end + Lunar New Year
    return ["YE", "QE"]               # All others: year-end + quarter-ends
