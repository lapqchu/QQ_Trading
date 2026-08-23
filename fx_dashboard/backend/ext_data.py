"""
ext_data — tiny HTTP fetch layer for non-LSEG official sources
(SingStat Table Builder, data.gov.sg, MAS chart JSON, …).

Design rules (mirrors the LSEG quota philosophy):
  - Everything here is slow-moving official statistics → cache HARD.
  - Disk cache (JSON) with per-entry TTL, under backend/.fund_cache/.
  - On any fetch failure, serve the stale cached copy (stamped stale=True)
    rather than raising — the dashboard should degrade, not break.
  - Browser User-Agent: several gov endpoints (mas.gov.sg in particular)
    reject default python UAs.

All public helpers return plain dicts (JSON-safe).
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger("ext_data")

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".fund_cache")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_session = requests.Session()
_session.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})


def _cache_path(key: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
    return os.path.join(CACHE_DIR, f"{safe}.json")


def _read_cache(key: str) -> Optional[Dict[str, Any]]:
    try:
        with open(_cache_path(key), "r") as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache(key: str, payload: Dict[str, Any]) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(_cache_path(key), "w") as f:
            json.dump(payload, f)
    except Exception as e:  # cache write failure is never fatal
        log.warning("cache write failed for %s: %s", key, e)


def get_json(url: str, key: str, ttl: float, params: Optional[Dict[str, str]] = None,
             timeout: float = 20.0) -> Dict[str, Any]:
    """
    Fetch JSON with disk cache. Returns {"data": <parsed>, "fetchedAt": ts, "stale": bool}.
    Serves cache when fresh; on fetch error serves stale cache (stale=True) or
    {"data": None, "error": str}.
    """
    cached = _read_cache(key)
    now = time.time()
    if cached and (now - cached.get("fetchedAt", 0)) < ttl:
        cached["stale"] = False
        return cached
    try:
        r = _session.get(url, params=params, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        payload = {"data": data, "fetchedAt": now, "stale": False, "url": r.url}
        _write_cache(key, payload)
        return payload
    except Exception as e:
        log.warning("ext fetch failed %s (%s): %s", key, url, str(e)[:200])
        if cached:
            cached["stale"] = True
            cached["error"] = str(e)[:200]
            return cached
        return {"data": None, "fetchedAt": None, "stale": True, "error": str(e)[:200]}


# ───────────────────────── SingStat Table Builder ─────────────────────────
# GET https://tablebuilder.singstat.gov.sg/api/table/tabledata/{id}
# No auth; ~100 calls/min/IP. `limit`/`offset` count CELLS (max 5000), flattened
# row-by-row — so always constrain rows (seriesNoORrowNo) and periods (timeFilter).
# Response rows: {"seriesNo": "1.03.1", "rowText": "Accommodation",
#                 "columns": [{"key": "2026 Jun", "value": "102.081"}, ...]}

_SS_BASE = "https://tablebuilder.singstat.gov.sg/api/table/tabledata"
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _month_keys(start_year: int) -> str:
    """Comma list of SingStat monthly period keys from start_year..current month."""
    now = time.localtime()
    keys = []
    for y in range(start_year, now.tm_year + 1):
        for mi, m in enumerate(_MONTHS, start=1):
            if y == now.tm_year and mi > now.tm_mon:
                break
            keys.append(f"{y} {m}")
    return ",".join(keys)


def _quarter_keys(start_year: int) -> str:
    now = time.localtime()
    keys = []
    for y in range(start_year, now.tm_year + 1):
        for q in range(1, 5):
            if y == now.tm_year and q > (now.tm_mon + 2) // 3:
                break
            keys.append(f"{y} {q}Q")
    return ",".join(keys)


def _parse_period(key: str) -> Optional[str]:
    """SingStat period key → ISO date (month-end / quarter-end)."""
    try:
        parts = key.strip().split()
        year = int(parts[0])
        tok = parts[1]
        if tok.endswith("Q"):
            q = int(tok[0])
            month = q * 3
        else:
            month = _MONTHS.index(tok) + 1
        # month-end day
        if month == 12:
            return f"{year}-12-31"
        import datetime as _dt
        d = _dt.date(year, month + 1, 1) - _dt.timedelta(days=1)
        return d.isoformat()
    except Exception:
        return None


def singstat_table(table_id: str, series: Optional[List[str]] = None,
                   start_year: int = 2016, quarterly: bool = False,
                   ttl: float = 6 * 3600) -> Dict[str, Any]:
    """
    Pull selected series from a SingStat table.
    Returns {"series": {seriesNo: {"label": str, "points": {iso: float}}},
             "stale": bool, "fetchedAt": ts}

    NOTE: a long `timeFilter` list 404s (URL-length limit), so we use
    `sortBy=key desc` + the cell cap instead: `limit` counts CELLS (max 5000)
    flattened row-by-row, and with descending sort each row gets its latest
    ⌊limit / n_rows⌋ periods — ample for our row counts. start_year only trims
    the parsed output.
    """
    params: Dict[str, str] = {"sortBy": "key desc", "limit": "5000"}
    if series:
        params["seriesNoORrowNo"] = ",".join(series)
    key = f"singstat_{table_id}_{'-'.join(series or ['all'])}_{start_year}"
    raw = get_json(f"{_SS_BASE}/{table_id}", key=key, ttl=ttl, params=params)
    out: Dict[str, Any] = {"series": {}, "stale": raw.get("stale", True),
                           "fetchedAt": raw.get("fetchedAt"), "error": raw.get("error")}
    data = (raw.get("data") or {}).get("Data") or {}
    min_iso = f"{start_year}-01-01"
    for row in data.get("row", []) or []:
        pts = {}
        for c in row.get("columns", []) or []:
            iso = _parse_period(c.get("key", ""))
            try:
                v = float(str(c.get("value", "")).replace(",", ""))
            except Exception:
                continue
            if iso and iso >= min_iso:
                pts[iso] = v
        out["series"][str(row.get("seriesNo"))] = {
            "label": (row.get("rowText") or "").strip(), "points": pts}
    out["title"] = data.get("title")
    out["lastUpdated"] = data.get("dataLastUpdated")
    return out


# ───────────────────────── data.gov.sg datastore ─────────────────────────
# GET https://data.gov.sg/api/action/datastore_search?resource_id=...
# Unkeyed: keep to ≤3 calls / 10s. We make 1 call per TTL window.

_DGS_URL = "https://data.gov.sg/api/action/datastore_search"


def datagov_search(resource_id: str, limit: int = 500, sort: str = "_id desc",
                   ttl: float = 3 * 3600) -> Dict[str, Any]:
    """Latest rows of a data.gov.sg dataset. Returns {"records": [...], "stale": bool}."""
    raw = get_json(_DGS_URL, key=f"dgs_{resource_id}_{limit}", ttl=ttl,
                   params={"resource_id": resource_id, "limit": str(limit), "sort": sort})
    result = ((raw.get("data") or {}).get("result")) or {}
    return {"records": result.get("records", []), "total": result.get("total"),
            "stale": raw.get("stale", True), "fetchedAt": raw.get("fetchedAt"),
            "error": raw.get("error")}


# ───────────────────────── MAS API portal (keyed, optional) ─────────────────────────
# The official replacement for the dead datastore API. Needs a KeyId header from a
# (free, guest) subscription at eservices.mas.gov.sg/apimg-portal. We use it only as
# an official fallback/validator feed — everything works without it.
#   product 10484 daily SORA:  /server/monthly_statistical_bulletin_non610mssql/
#       domestic_interest_rates_daily/views/domestic_interest_rates_daily
#   product 10485 daily FX:    /server/monthly_statistical_bulletin_non610ora/
#       exchange_rates_end_of_period_daily/views/exchange_rates_end_of_period_daily
# Denodo query params: $filter / $select / $orderby / $start_index (+ column params).

_MAS_GW = "https://eservices.mas.gov.sg/apimg-gw"


def mas_api_available() -> bool:
    return bool(os.environ.get("MAS_API_KEY"))


def mas_api(path: str, params: Optional[Dict[str, str]] = None,
            ttl: float = 12 * 3600) -> Dict[str, Any]:
    """GET a MAS API-portal view (path relative to the gateway root). Returns the
    same envelope as get_json; {"data": None, "error": "no MAS_API_KEY"} when the
    key is absent."""
    key_id = os.environ.get("MAS_API_KEY")
    if not key_id:
        return {"data": None, "stale": True, "fetchedAt": None, "error": "no MAS_API_KEY"}
    url = f"{_MAS_GW}/{path.lstrip('/')}"
    cache_key = "masapi_" + path.strip("/").replace("/", "_")[-80:]
    cached = _read_cache(cache_key)
    now = time.time()
    if cached and (now - cached.get("fetchedAt", 0)) < ttl:
        cached["stale"] = False
        return cached
    try:
        r = _session.get(url, params=params, headers={"KeyId": key_id}, timeout=25)
        r.raise_for_status()
        payload = {"data": r.json(), "fetchedAt": now, "stale": False, "url": r.url}
        _write_cache(cache_key, payload)
        return payload
    except Exception as e:
        log.warning("MAS API fetch failed %s: %s", path, str(e)[:200])
        if cached:
            cached["stale"] = True
            cached["error"] = str(e)[:200]
            return cached
        return {"data": None, "fetchedAt": None, "stale": True, "error": str(e)[:200]}


# ───────────────────────── MAS chart JSON (no auth) ─────────────────────────
# GET https://www.mas.gov.sg/api/v1/MAS/chart/rev/{view}
# Undocumented but stable-shaped: {"name": ..., "elements": [ {...}, ... ]} newest first.

_MAS_CHART = "https://www.mas.gov.sg/api/v1/MAS/chart"


def mas_chart(view: str, rev: bool = True, ttl: float = 12 * 3600) -> Dict[str, Any]:
    url = f"{_MAS_CHART}/{'rev/' if rev else ''}{view}"
    raw = get_json(url, key=f"mas_{view}", ttl=ttl)
    els = (raw.get("data") or {}).get("elements") or []
    return {"elements": els, "stale": raw.get("stale", True),
            "fetchedAt": raw.get("fetchedAt"), "error": raw.get("error")}
