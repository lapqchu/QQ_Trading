"""
SG Fundamentals — Singapore country-fundamentals monitor (deep-dive tab 4).

First instance of the per-country fundamentals template (see SG_FUNDAMENTALS_PLAN.md).
Replicates the indicator set MAS itself tracks (Macroeconomic Review chapters,
MPS, Staff Papers, BIS Paper 142) from:

  - LSEG economic-indicator RICs (aSG…) + Reuters-poll RICs (SG…=ECI)  ← primary
  - SingStat Table Builder (CPI groups incl. Accommodation / Private Transport,
    MAS-core groupings, GDP, URA rents)                                 ← gap-filler
  - data.gov.sg (COE bidding results, same-day)                         ← gap-filler

Quota philosophy: everything is monthly/quarterly official data. One build per
TTL (6h) — the frontend fetches once on mount + manual refresh; NO polling.
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
import time
from typing import Any, Dict, List, Optional

import ext_data

log = logging.getLogger("sg_fund")

_START_YEAR = 2016          # history window for charts
_TTL = 6 * 3600             # full-payload cache

# ───────────────────────── LSEG monthly econ-indicator registry ─────────────────────────
# transform: "level" (plot as-is) | "yoy" (compute % y/y from index level)
# freq: "m" monthly | "q" quarterly
LSEG_SERIES: Dict[str, Dict[str, Any]] = {
    "cpi":        {"ric": "aSGCPI",      "label": "CPI All Items (2024=100)",   "transform": "yoy",   "freq": "m"},
    "core":       {"ric": "aSGCPICOR",   "label": "MAS Core y/y",               "transform": "level", "freq": "m"},
    "impPrices":  {"ric": "aSGIMPP",     "label": "Import prices",              "transform": "yoy",   "freq": "m"},
    "expPrices":  {"ric": "aSGEXPP",     "label": "Export prices",              "transform": "yoy",   "freq": "m"},
    "tot":        {"ric": "aSGTOTRD/C",  "label": "Terms of trade",             "transform": "level", "freq": "m"},
    "retail":     {"ric": "aSGRSLSM/CA", "label": "Retail sales volume",        "transform": "yoy",   "freq": "m"},
    "ip":         {"ric": "aSGIP/C",     "label": "Industrial production",      "transform": "yoy",   "freq": "m"},
    "nodx":       {"ric": "aSGEXPDNO",   "label": "NODX",                       "transform": "yoy",   "freq": "m"},
    "unemp":      {"ric": "aSGCUNPQ/A",  "label": "Unemployment rate (SA)",     "transform": "level", "freq": "m"},
    "vacancies":  {"ric": "aSGCVACP",    "label": "Job vacancies",              "transform": "yoy",   "freq": "m"},
    "m2":         {"ric": "aSGM2",       "label": "Money supply M2",            "transform": "yoy",   "freq": "m"},
    "loansBiz":   {"ric": "aSGLABUS",    "label": "Bank loans: businesses",     "transform": "yoy",   "freq": "m"},
    "loansCons":  {"ric": "aSGCSMLOAN",  "label": "Bank loans: consumers",      "transform": "yoy",   "freq": "m"},
    "loansHous":  {"ric": "aSGCRDNBCHL", "label": "Housing & bridging loans",   "transform": "yoy",   "freq": "m"},
    "reserves":   {"ric": "aSGFXRESO",   "label": "Official foreign reserves",  "transform": "level", "freq": "m"},
    "neerOff":    {"ric": "aSGDEOP",     "label": "Official S$NEER (weekly avg)","transform": "yoy",  "freq": "m"},
    "pmi":        {"ric": "aSGPMIRA",    "label": "SIPMM PMI",                  "transform": "level", "freq": "m"},
    "coeCarSm":   {"ric": "aSGMVBPQPBC", "label": "COE PQP cars ≤1600cc",       "transform": "level", "freq": "m"},
    "coeCarLg":   {"ric": "aSGMVBPQPAC", "label": "COE PQP cars >1600cc",       "transform": "level", "freq": "m"},
    "ulc":        {"ric": "aSGULCT",     "label": "Unit labour cost",           "transform": "yoy",   "freq": "q"},
    # NOTE: both LSEG wage series (aSGWAGESXR, aSGEARNMN) are stale at 2024-Q3 —
    # resident wage growth needs the MOM source (P2 follow-up).
}

# Reuters-poll RICs → consensus for upcoming prints (single snapshot)
POLL_RICS: Dict[str, Dict[str, str]] = {
    "cpiYoY":    {"ric": "SGCPIY=ECI",  "label": "CPI y/y"},
    "coreYoY":   {"ric": "SGCPYY=ECI",  "label": "MAS Core y/y"},
    "retailYoY": {"ric": "SGRSLY=ECI",  "label": "Retail sales y/y"},
    "ipYoY":     {"ric": "SGMFGY=ECI",  "label": "Industrial production y/y"},
    "nodxYoY":   {"ric": "SGXOILY=ECI", "label": "NODX y/y"},
    "gdpYoY":    {"ric": "SGGDQY=ECI",  "label": "GDP y/y"},
    "unemp":     {"ric": "SGUNRF=ECI",  "label": "Unemployment rate"},
}
POLL_FIELDS = ["ECON_ACT", "ECON_PRIOR", "FCAST_MEAN", "FCAST_HIGH", "FCAST_LOW", "VALUE_DT1"]

# ───────────────────────── CPI structure (2024 base, weights per 10,000) ─────────────────
# From the DOS rebasing information paper (Feb 2025). seriesNo = SingStat M213751.
CPI_COMPONENTS: List[Dict[str, Any]] = [
    {"s": "1.01",   "key": "foodExFbs",   "label": "Food ex F&B serving",      "w": 651,  "core": True},
    {"s": "1.11",   "key": "fbs",         "label": "F&B serving services",     "w": 1391, "core": True},
    {"s": "1.02",   "key": "clothing",    "label": "Clothing & footwear",      "w": 165,  "core": True},
    {"s": "1.03.1", "key": "accom",       "label": "Accommodation",            "w": 2656, "core": False},
    {"s": "1.03.2", "key": "utilities",   "label": "Utilities & other fuels",  "w": 282,  "core": True},
    {"s": "1.04",   "key": "durables",    "label": "Household durables & svcs","w": 547,  "core": True},
    {"s": "1.05",   "key": "health",      "label": "Health care",              "w": 1008, "core": True},
    {"s": "1.06.1", "key": "privTrans",   "label": "Private transport",        "w": 906,  "core": False},
    {"s": "1.06.2", "key": "landTrans",   "label": "Land transport services",  "w": 262,  "core": True},
    {"s": "1.06.3", "key": "otherTrans",  "label": "Other transport (airfares)","w": 139, "core": True},
    {"s": "1.07",   "key": "infocomm",    "label": "Info & communication",     "w": 381,  "core": True},
    {"s": "1.08",   "key": "recreation",  "label": "Recreation & culture",     "w": 595,  "core": True},
    {"s": "1.09",   "key": "education",   "label": "Education",                "w": 579,  "core": True},
    {"s": "1.10",   "key": "misc",        "label": "Miscellaneous",            "w": 438,  "core": True},
]
_CPI_ALL_SERIES = "1"   # All Items row in M213751

# SingStat M213891 — MAS core + groupings (rowNos verified live 2026-08-23)
CORE_GROUPS = {"1": "MAS Core index", "1.2": "MAS Core y/y", "2": "Services",
               "3": "Retail & other goods", "4": "Electricity & gas"}

# data.gov.sg COE bidding results (same-day per exercise)
COE_DATASET = "d_69b3380ad7e51aff3a7dcc84eba52b8a"

# ───────────────────────── Policy tables (verified 2026-08-23) ─────────────────────────
MPS_DECISIONS = [  # (date, action) — slope/width/centre wording condensed
    ("2016-04-14", "Slope to 0% (neutral)"),
    ("2016-10-14", "Hold"), ("2017-04-13", "Hold"), ("2017-10-13", "Hold"),
    ("2018-04-13", "Slope ↑ slightly"), ("2018-10-12", "Slope ↑ slightly"),
    ("2019-04-12", "Hold"), ("2019-10-14", "Slope ↓ slightly"),
    ("2020-03-30", "Slope to 0% + re-centre ↓"), ("2020-10-14", "Hold"),
    ("2021-04-14", "Hold"), ("2021-10-14", "Slope ↑ slightly"),
    ("2022-01-25", "Off-cycle: slope ↑ slightly"),
    ("2022-04-14", "Slope ↑ + re-centre ↑"),
    ("2022-07-14", "Off-cycle: re-centre ↑"),
    ("2022-10-14", "Re-centre ↑"),
    ("2023-04-14", "Hold"), ("2023-10-13", "Hold"),
    ("2024-01-29", "Hold"), ("2024-04-12", "Hold"), ("2024-07-26", "Hold"), ("2024-10-14", "Hold"),
    ("2025-01-24", "Slope ↓ slightly"), ("2025-04-14", "Slope ↓ slightly"),
    ("2025-07-30", "Hold"), ("2025-10-14", "Hold"),
    ("2026-01-29", "Hold"),
    ("2026-04-14", "Slope ↑ slightly"),
    ("2026-07-27", "Slope ↑ very slightly"),
]

FORECAST_VINTAGES_2026 = [  # MAS core & headline ranges for 2026, by statement
    {"asOf": "2025-10-14", "low": 0.5, "high": 1.5},
    {"asOf": "2026-01-29", "low": 1.0, "high": 2.0},
    {"asOf": "2026-04-14", "low": 1.5, "high": 2.5},
    {"asOf": "2026-07-27", "low": 1.5, "high": 2.5},
]

SPF_LATEST = {  # MAS Survey of Professional Forecasters, Jun 2026 medians
    "asOf": "2026-06", "cpi2026": 2.3, "core2026": 2.0, "cpi2027": 2.1, "core2027": 2.0,
    "gdp2026": 3.5, "unemp": 2.1, "usdsgdEnd2026": 1.258, "soraAvg2026": 1.20,
}

CALENDAR = [  # upcoming releases (MAS/DOS advance release calendar, verified)
    {"date": "2026-08-24", "event": "CPI Jul (consensus: headline 2.31%, core 2.2%)"},
    {"date": "2026-08-26", "event": "Industrial production Jul"},
    {"date": "2026-08-31", "event": "MAS Monthly Statistical Bulletin (Jul)"},
    {"date": "2026-09-04", "event": "Retail sales Jul · FAO food price index Aug"},
    {"date": "2026-09-07", "event": "Official reserves Aug · weekly S$NEER (Aug)"},
    {"date": "2026-09-16", "event": "SPF Q3 survey (NLT)"},
    {"date": "2026-09-17", "event": "NODX Aug"},
    {"date": "2026-09-23", "event": "CPI Aug"},
    {"date": "2026-09-30", "event": "FX intervention H1-2026 print (~end-Sep)"},
    {"date": "2026-10-14", "event": "MPS + Macroeconomic Review Oct (NLT)"},
    {"date": "2026-10-23", "event": "CPI Sep"},
]

MAS_RANGE_2026 = {"low": 1.5, "high": 2.5, "asOf": "2026-07-27",
                  "note": "MAS Core & CPI-All Items, 2026 average"}
OUTPUT_GAP_2026 = 0.7   # % of potential GDP, MR Jul 2026 Ch.3 (EPG estimate)


# ───────────────────────── helpers ─────────────────────────
def _yoy(dates: List[str], values: List[float]) -> Dict[str, List]:
    """% y/y from a monthly (or quarterly) index level series keyed by month-end dates."""
    by_month = {d[:7]: v for d, v in zip(dates, values) if v is not None}
    out_d, out_v = [], []
    for d, v in zip(dates, values):
        if v is None:
            continue
        y, m = int(d[:4]), int(d[5:7])
        prev = by_month.get(f"{y-1:04d}-{m:02d}")
        if prev:
            out_d.append(d)
            out_v.append(round((v / prev - 1.0) * 100.0, 3))
    return {"dates": out_d, "values": out_v}


def _series_from_hist(hist: Dict[str, List[dict]], ric: str) -> Dict[str, List]:
    """
    lseg_client.get_history returns either {ric: [{Date, VALUE}]} (per-RIC record
    sets) or — for multi-RIC single-field calls — {"default": [{Date, <ric>: v, …}]}
    with one column per RIC. Handle both.
    """
    records = hist.get(ric)
    col = "VALUE"
    if records is None and "default" in hist:
        records = hist["default"]
        col = ric
    dates, values = [], []
    for r in records or []:
        d = str(r.get("Date", ""))[:10]
        v = r.get(col, r.get("VALUE"))
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        dates.append(d)
        values.append(v)
    return {"dates": dates, "values": values}


def _pts_to_series(points: Dict[str, float]) -> Dict[str, List]:
    ks = sorted(points.keys())
    return {"dates": ks, "values": [points[k] for k in ks]}


class SgFundamentalsService:
    def __init__(self, lseg):
        self.lseg = lseg
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_ts: float = 0.0
        self._lock = threading.Lock()

    # ── LSEG pulls ──
    def _lseg_histories(self) -> Dict[str, Dict[str, List]]:
        today = dt.date.today().isoformat()
        start = f"{_START_YEAR}-01-01"
        out: Dict[str, Dict[str, List]] = {}
        monthly = [(k, s["ric"]) for k, s in LSEG_SERIES.items() if s["freq"] == "m"]
        quarterly = [(k, s["ric"]) for k, s in LSEG_SERIES.items() if s["freq"] == "q"]
        # Chunk ≤8 RICs per call ourselves: lseg_client merges each multi-RIC
        # single-field result under one "default" key, so its internal 10-RIC
        # chunks would clobber each other on a bigger batch.
        for i in range(0, len(monthly), 8):
            chunk = monthly[i:i + 8]
            try:
                hist = self.lseg.get_history([r for _, r in chunk], fields=["VALUE"],
                                             interval="monthly", start=start, end=today)
            except Exception as e:
                log.error("monthly history chunk failed: %s", e)
                hist = {}
            for k, ric in chunk:
                out[k] = _series_from_hist(hist, ric)
        try:
            qh = self.lseg.get_history([r for _, r in quarterly], fields=["VALUE"],
                                       interval="quarterly", start=start, end=today)
        except Exception as e:
            log.error("quarterly history failed: %s", e)
            qh = {}
        for k, ric in quarterly:
            out[k] = _series_from_hist(qh, ric)
        return out

    def _poll_snapshot(self) -> Dict[str, Any]:
        rics = [p["ric"] for p in POLL_RICS.values()]
        try:
            snap = self.lseg.get_snapshot(rics, POLL_FIELDS)
        except Exception as e:
            log.error("poll snapshot failed: %s", e)
            snap = {}
        def _clean(v):
            """pandas <NA>/numpy scalars → JSON-safe python values."""
            if v is None:
                return None
            try:
                import pandas as pd
                if pd.isna(v):
                    return None
            except (TypeError, ValueError):
                pass
            if hasattr(v, "item"):
                try:
                    return v.item()
                except Exception:
                    pass
            if isinstance(v, (int, float, str, bool)):
                return v
            return str(v)

        rows = []
        for key, p in POLL_RICS.items():
            s = snap.get(p["ric"], {}) or {}
            rows.append({
                "key": key, "label": p["label"], "ric": p["ric"],
                "actual": _clean(s.get("ECON_ACT")), "prior": _clean(s.get("ECON_PRIOR")),
                "mean": _clean(s.get("FCAST_MEAN")), "high": _clean(s.get("FCAST_HIGH")),
                "low": _clean(s.get("FCAST_LOW")), "releaseDate": _clean(s.get("VALUE_DT1")),
            })
        return {"rows": rows}

    # ── external pulls ──
    def _cpi_groups(self) -> Dict[str, Any]:
        series = [_CPI_ALL_SERIES] + [c["s"] for c in CPI_COMPONENTS]
        return ext_data.singstat_table("M213751", series=series, start_year=_START_YEAR)

    def _core_groups(self) -> Dict[str, Any]:
        return ext_data.singstat_table("M213891", series=list(CORE_GROUPS.keys()),
                                       start_year=2019)

    def _gdp(self) -> Dict[str, Any]:
        return ext_data.singstat_table("M015631", series=["1", "2"],
                                       start_year=_START_YEAR, quarterly=True)

    def _ura_rent(self) -> Dict[str, Any]:
        return ext_data.singstat_table("M212311", series=["1"],
                                       start_year=_START_YEAR, quarterly=True)

    def _coe(self) -> Dict[str, Any]:
        res = ext_data.datagov_search(COE_DATASET, limit=600)
        hist: Dict[str, Dict[str, float]] = {}   # "YYYY-MM-b#" per class
        latest: Dict[str, Any] = {}
        for r in res.get("records", []):
            cls = str(r.get("vehicle_class", ""))
            try:
                prem = float(r.get("premium"))
            except (TypeError, ValueError):
                continue
            key = f"{r.get('month')}-{r.get('bidding_no')}"
            hist.setdefault(cls, {})[key] = prem
            cur = latest.get(cls)
            if cur is None or key > cur["exercise"]:
                latest[cls] = {"exercise": key, "premium": prem,
                               "quota": r.get("quota"), "bids": r.get("bids_received")}
        out_hist = {}
        for cls, pts in hist.items():
            ks = sorted(pts.keys())
            out_hist[cls] = {"exercises": ks, "premiums": [pts[k] for k in ks]}
        return {"latest": latest, "history": out_hist,
                "stale": res.get("stale"), "error": res.get("error")}

    # ── contribution math ──
    @staticmethod
    def _contributions(cpi_tbl: Dict[str, Any]) -> Dict[str, Any]:
        """Laspeyres y/y contributions per component (pp of headline y/y), latest month."""
        ss = cpi_tbl.get("series", {})
        all_pts = (ss.get(_CPI_ALL_SERIES) or {}).get("points", {})
        if not all_pts:
            return {"asOf": None, "rows": []}
        latest = max(all_pts.keys())
        y, m = int(latest[:4]), latest[5:7]
        prev_key = None
        for d in all_pts:
            if d.startswith(f"{y-1:04d}-{m}"):
                prev_key = d
                break
        if not prev_key:
            return {"asOf": latest, "rows": []}
        all_prev = all_pts[prev_key]
        rows = []
        core_contrib = 0.0
        noncore_contrib = 0.0
        for c in CPI_COMPONENTS:
            pts = (ss.get(c["s"]) or {}).get("points", {})
            cur, prev = pts.get(latest), pts.get(prev_key)
            if cur is None or prev is None:
                rows.append({**{k: c[k] for k in ("key", "label", "w", "core")},
                             "yoy": None, "contribution": None})
                continue
            yoy = (cur / prev - 1.0) * 100.0
            contrib = (c["w"] / 10000.0) * (cur - prev) / all_prev * 100.0
            if c["core"]:
                core_contrib += contrib
            else:
                noncore_contrib += contrib
            rows.append({**{k: c[k] for k in ("key", "label", "w", "core")},
                         "yoy": round(yoy, 2), "contribution": round(contrib, 3)})
        headline_yoy = (all_pts[latest] / all_prev - 1.0) * 100.0
        return {"asOf": latest, "rows": rows,
                "headlineYoY": round(headline_yoy, 2),
                "coreContrib": round(core_contrib, 3),
                "nonCoreContrib": round(noncore_contrib, 3)}

    # ── main payload ──
    def monitor(self, refresh: bool = False) -> Dict[str, Any]:
        with self._lock:
            if (not refresh and self._cache
                    and (time.time() - self._cache_ts) < _TTL):
                return self._cache
            t0 = time.time()
            hist = self._lseg_histories()
            polls = self._poll_snapshot()
            cpi_tbl = self._cpi_groups()
            core_tbl = self._core_groups()
            gdp_tbl = self._gdp()
            rent_tbl = self._ura_rent()
            coe = self._coe()

            def series(key: str) -> Dict[str, List]:
                s = hist.get(key) or {"dates": [], "values": []}
                if LSEG_SERIES[key]["transform"] == "yoy":
                    return _yoy(s["dates"], s["values"])
                return s

            def latest(sr: Dict[str, List]):
                return (sr["dates"][-1], sr["values"][-1]) if sr.get("values") else (None, None)

            contrib = self._contributions(cpi_tbl)

            core_grp_series = {}
            for no, label in CORE_GROUPS.items():
                pts = (core_tbl.get("series", {}).get(no) or {}).get("points", {})
                if no == "1.2":       # already y/y
                    core_grp_series["coreYoYOfficial"] = _pts_to_series(pts)
                elif no != "1":
                    sr = _pts_to_series(pts)
                    core_grp_series[label] = _yoy(sr["dates"], sr["values"])

            # Row "2" = GDP In Chained (2015) Dollars (real y/y); row "1" is nominal.
            gdp_series = {}
            grows = gdp_tbl.get("series") or {}
            pick = grows.get("2") or next(
                (r for r in grows.values() if "chained" in (r.get("label") or "").lower()), None)
            if pick:
                gdp_series = _pts_to_series(pick.get("points", {}))

            rent_series = {}
            rrow = (rent_tbl.get("series") or {}).get("1") or {}
            if rrow.get("points"):
                sr = _pts_to_series(rrow["points"])
                rent_series = {"index": sr, "yoy": _yoy(sr["dates"], sr["values"])}

            headline = series("cpi")
            core = series("core")
            payload: Dict[str, Any] = {
                "asOf": dt.datetime.now().isoformat(timespec="seconds"),
                "buildSecs": None,
                "inflation": {
                    "headlineYoY": headline,
                    "coreYoY": core,
                    "latest": {"headline": latest(headline)[1], "core": latest(core)[1],
                               "month": latest(headline)[0]},
                    "contributions": contrib,
                    "coreGroupsYoY": core_grp_series,
                    "masRange2026": MAS_RANGE_2026,
                    "forecastVintages2026": FORECAST_VINTAGES_2026,
                },
                "consensus": polls,
                "drivers": {
                    "importPricesYoY": series("impPrices"),
                    "exportPricesYoY": series("expPrices"),
                    "termsOfTrade": series("tot"),
                    "neerYoY": series("neerOff"),
                    "coe": coe,
                    "coeMonthly": {"small": series("coeCarSm"), "large": series("coeCarLg")},
                    "uraRent": rent_series,
                    "tariff": {"note": "SP Group Q3-26: electricity +17.0% to 31.91¢/kWh ex-GST, gas +7%",
                               "asOf": "2026-07-01"},
                },
                "activity": {
                    "gdpYoY": gdp_series,
                    "ipYoY": series("ip"),
                    "nodxYoY": series("nodx"),
                    "retailYoY": series("retail"),
                    "pmi": series("pmi"),
                    "mtiGdpRange2026": {"low": 4.5, "high": 5.5, "asOf": "2026-08-11"},
                    "outputGap2026": OUTPUT_GAP_2026,
                },
                "labour": {
                    "unemp": series("unemp"),
                    "ulcYoY": series("ulc"),
                    "vacanciesYoY": series("vacancies"),
                    "note": "Resident wage growth pending MOM source (LSEG wage series stale at 2024-Q3)",
                },
                "monetary": {
                    "m2YoY": series("m2"),
                    "loansBizYoY": series("loansBiz"),
                    "loansConsYoY": series("loansCons"),
                    "loansHousYoY": series("loansHous"),
                    "reserves": series("reserves"),
                },
                "policy": {
                    "decisions": [{"date": d, "action": a} for d, a in MPS_DECISIONS],
                    "nextMeeting": "NLT 2026-10-14",
                    "spf": SPF_LATEST,
                },
                "calendar": CALENDAR,
                "sources": {
                    "cpiGroups": {"stale": cpi_tbl.get("stale"), "lastUpdated": cpi_tbl.get("lastUpdated"), "error": cpi_tbl.get("error")},
                    "coreGroups": {"stale": core_tbl.get("stale"), "error": core_tbl.get("error")},
                    "gdp": {"stale": gdp_tbl.get("stale"), "error": gdp_tbl.get("error")},
                    "uraRent": {"stale": rent_tbl.get("stale"), "error": rent_tbl.get("error")},
                    "coe": {"stale": coe.get("stale"), "error": coe.get("error")},
                },
            }
            payload["buildSecs"] = round(time.time() - t0, 2)
            self._cache = payload
            self._cache_ts = time.time()
            return payload
