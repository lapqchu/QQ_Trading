"""
Turn-date calendar generator.

A "turn" in FX swap / NDF markets is a calendar boundary across which funding
becomes special and the 1-day implied yield gaps. The turn date is the value
date over which the spike occurs (industry convention; see CME / LSEG docs).

This module produces a list of upcoming turn dates per currency for use by
the clean-curve bootstrap. Per-currency rules live on `CurrencyConfig.turn_types`
in ric_config.py — defaults to ["YE", "QE"] for most currencies; INR adds "ME";
TWD trims to ["YE"]; KRW adds "LUNAR" approximation.

Adjustments:
- A turn that falls on a weekend shifts to the prior Friday (industry convention
  — the funding squeeze is felt on the last business day before the calendar
  boundary, not the boundary itself when it's non-business).
- We don't yet apply per-ccy holiday calendars — the snapshot's IPA-resolved
  value dates already reflect ccy-specific holidays, and the bootstrap matches
  turns to swap value-date windows, so a one-day mis-shift is absorbed by the
  windowing.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, List, Optional


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
    iso: str       # YYYY-MM-DD (the value date over which the turn occurs)
    type: str      # YE | QE | ME | LUNAR
    label: str     # human-readable label, e.g. "YE 2026"

    def to_dict(self) -> dict:
        return {"date": self.iso, "type": self.type, "label": self.label}


def _last_biz_day(y: int, m: int) -> date:
    """Last business day of month m in year y (Sat/Sun shifts back to Fri)."""
    # Find last calendar day of the month.
    if m == 12:
        first_next = date(y + 1, 1, 1)
    else:
        first_next = date(y, m + 1, 1)
    d = first_next - timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d -= timedelta(days=1)
    return d


def _adjust_to_biz_day(d: date) -> date:
    """If date is Sat/Sun, shift back to Fri. Industry convention: the
    funding spike is felt on the last business day before the calendar
    boundary."""
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def generate_turns(turn_types: Iterable[str], spot: date,
                   horizon_months: int = 24) -> List[Turn]:
    """
    Generate concrete turn dates from `spot` through `spot + horizon_months`.

    turn_types: subset of {"YE", "QE", "ME", "LUNAR"}.
    spot:       spot value date (the bootstrap baseline).
    horizon_months: how far forward to generate; 24 matches the dashboard's
                    max_display_m=24.

    Returns turns sorted by date, deduped (a year-end is also a quarter-end
    is also a month-end — keep only the most-specific type per date with
    priority YE > LUNAR > QE > ME).
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

    if "ME" in types:
        # All month-ends within horizon
        y, m = spot.year, spot.month
        while True:
            d = _last_biz_day(y, m)
            if d >= horizon_end:
                break
            if d > spot:
                _add(d, "ME", f"ME {d.strftime('%b %Y')}")
            m += 1
            if m > 12:
                m = 1
                y += 1

    if "QE" in types:
        # Mar / Jun / Sep / Dec last business day
        y = spot.year
        while date(y, 1, 1) < horizon_end:
            for m in (3, 6, 9, 12):
                d = _last_biz_day(y, m)
                if d > spot and d < horizon_end:
                    label = f"YE {y}" if m == 12 else f"QE {d.strftime('%b %Y')}"
                    t_type = "YE" if m == 12 else "QE"
                    if t_type in types or m == 12:  # YE always counts if QE is enabled
                        _add(d, t_type, label)
            y += 1

    if "YE" in types and "QE" not in types:
        # Just year-end (e.g., TWD)
        y = spot.year
        while date(y, 1, 1) < horizon_end:
            d = _last_biz_day(y, 12)
            if d > spot and d < horizon_end:
                _add(d, "YE", f"YE {y}")
            y += 1

    if "LUNAR" in types:
        for y, lny in _LUNAR_NEW_YEAR.items():
            if y < spot.year - 1 or y > spot.year + (horizon_months // 12) + 1:
                continue
            adj = _adjust_to_biz_day(lny)
            _add(adj, "LUNAR", f"Lunar {y}")

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
        return ["YE", "QE", "ME"]   # INR NDF: month-ends matter (RBI / FBIL)
    if code == "TWD":
        return ["YE"]                # TWD NDF: only year-end (per user)
    if code == "KRW":
        return ["YE", "QE", "LUNAR"] # KRW NDF: year-end + Lunar New Year
    return ["YE", "QE"]              # All others: year-end + quarter-ends
