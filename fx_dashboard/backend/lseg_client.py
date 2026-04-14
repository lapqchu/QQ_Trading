"""
LSEG Workspace (desktop session) client wrapper.

Uses `lseg-data` SDK (formerly refinitiv-data).
Desktop session: connects to local Workspace app running on the same PC.
Requires an App Key generated inside Workspace (App Key Generator tool).

Install:  pip install lseg-data
Docs:     https://developers.lseg.com/en/api-catalog/refinitiv-data-platform/refinitiv-data-library-for-python
"""

from __future__ import annotations
import logging
import os
import threading
from typing import Callable, Dict, List, Optional, Any
from datetime import datetime, timedelta

log = logging.getLogger(__name__)

# lseg-data is not imported at module level so code can be introspected without the SDK installed.
# Import happens lazily in the relevant methods.


class LsegClient:
    """
    Thin wrapper around lseg-data desktop session.

    Usage:
        client = LsegClient(app_key=os.environ["LSEG_APP_KEY"])
        client.open()
        snap = client.get_snapshot(["USDTWD=", "TWD1MNDFOR="], ["BID", "ASK"])
        client.subscribe(["TWD=", "TWD1MNDFOR=ICAP"], on_update=lambda ric, f: print(ric, f))
        client.close()
    """

    def __init__(self, app_key: Optional[str] = None):
        self.app_key = app_key or os.environ.get("LSEG_APP_KEY")
        self._session = None
        self._streams: Dict[str, Any] = {}   # keyed by subscription tag
        self._lock = threading.Lock()

    # ─────────────────────────── session ───────────────────────────
    def open(self) -> None:
        """Open a desktop session to the local Workspace app."""
        import lseg.data as ld
        # ld.open_session() opens and registers the session as default in one call.
        # The desktop.workspace session connects to the running Workspace app via port 9005.
        if self.app_key:
            ld.open_session(name="desktop.workspace", app_key=self.app_key)
        else:
            ld.open_session(name="desktop.workspace")
        self._session = ld.session.get_default()
        log.info("LSEG desktop session opened")

    def close(self) -> None:
        """Close all streams & session."""
        with self._lock:
            for tag, stream in list(self._streams.items()):
                try:
                    stream.close()
                except Exception as e:
                    log.warning("Stream %s close failed: %s", tag, e)
            self._streams.clear()
        import lseg.data as ld
        try:
            ld.close_session()
        except Exception:
            pass
        log.info("LSEG session closed")

    # ────────────────────────── snapshot ──────────────────────────
    def get_snapshot(self, rics: List[str], fields: List[str]) -> Dict[str, Dict[str, Any]]:
        """
        One-shot snapshot for a list of RICs.

        Returns: { ric: { field: value, ... }, ... }
        """
        import lseg.data as ld
        df = ld.get_data(universe=rics, fields=fields)
        out: Dict[str, Dict[str, Any]] = {}
        if df is None or df.empty:
            return out
        # df index is RIC ('Instrument' column or index)
        for _, row in df.iterrows():
            ric = row.get("Instrument") or row.name
            out[ric] = {f: row.get(f) for f in fields if f in row.index}
        return out

    # ────────────────────────── history ───────────────────────────
    def get_history(
        self,
        rics: List[str],
        fields: List[str] = ("BID", "ASK", "TRDPRC_1"),
        interval: str = "daily",
        start: Optional[str] = None,
        end: Optional[str] = None,
        count: Optional[int] = None,
    ) -> Dict[str, list]:
        """
        Historical time series.

        interval:  'tick' | 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly'
        start/end: ISO date strings; OR use `count` for last-N bars.
        """
        import lseg.data as ld
        import pandas as pd
        pd.set_option("future.no_silent_downcasting", True)
        kwargs: Dict[str, Any] = {"universe": rics, "fields": list(fields), "interval": interval}
        if start: kwargs["start"] = start
        if end: kwargs["end"] = end
        if count: kwargs["count"] = count
        try:
            df = ld.get_history(**kwargs)
        except (TypeError, KeyError, AttributeError) as e:
            # SDK bug: multi-RIC intraday queries throw when some RICs have no data.
            # Fall back to per-RIC queries (slower but reliable).
            log.info("get_history batch failed (%s); falling back per-RIC", e)
            result: Dict[str, list] = {}
            for r in rics:
                one_kwargs = dict(kwargs); one_kwargs["universe"] = [r]
                try:
                    subdf = ld.get_history(**one_kwargs)
                except Exception as e2:
                    log.debug("per-RIC history %s failed: %s", r, e2)
                    continue
                if subdf is None or subdf.empty:
                    continue
                sub = subdf.reset_index()
                sub["Date"] = sub.iloc[:, 0].astype(str)
                result[r] = sub.to_dict(orient="records")
            return result
        if df is None or df.empty:
            return {}
        # Convert to JSON-friendly format
        result: Dict[str, list] = {}
        # With multiple RICs, lseg-data returns multi-index columns
        if isinstance(df.columns, type(df.columns)) and df.columns.nlevels > 1:
            for ric in rics:
                if ric in df.columns.get_level_values(0):
                    sub = df[ric].reset_index()
                    sub["Date"] = sub.iloc[:, 0].astype(str)
                    result[ric] = sub.to_dict(orient="records")
        else:
            sub = df.reset_index()
            sub["Date"] = sub.iloc[:, 0].astype(str)
            result[rics[0] if len(rics) == 1 else "default"] = sub.to_dict(orient="records")
        return result

    # ────────────────────── realtime streaming ─────────────────────
    def subscribe(
        self,
        tag: str,
        rics: List[str],
        fields: List[str],
        on_update: Callable[[str, Dict[str, Any]], None],
        on_refresh: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    ):
        """
        Open a level-1 streaming subscription for RICs.

        `tag` uniquely identifies the stream so it can be closed later.
        `on_update(ric, fields_dict)` is called on every tick update.
        """
        import lseg.data as ld
        if tag in self._streams:
            log.info("Replacing existing stream %s", tag)
            try: self._streams[tag].close()
            except Exception: pass

        stream = ld.content.pricing.Definition(
            universe=rics,
            fields=fields,
        ).get_stream()

        # Tick counter for diagnostics
        _tick_count = {"update": 0, "refresh": 0}

        def _extract_fields(raw):
            """Safely extract a plain dict from LSEG SDK update/fields objects."""
            if isinstance(raw, dict):
                return raw
            # Try common LSEG SDK patterns
            if hasattr(raw, 'data') and hasattr(raw.data, 'raw'):
                return dict(raw.data.raw)
            if hasattr(raw, 'data'):
                try: return dict(raw.data)
                except Exception: pass
            # Try direct dict conversion
            try: return dict(raw)
            except Exception: pass
            # Last resort: iterate known fields
            out = {}
            for f in fields:
                try:
                    v = raw[f] if hasattr(raw, '__getitem__') else getattr(raw, f, None)
                    if v is not None:
                        out[f] = v
                except Exception:
                    pass
            return out

        def _find_fields_and_instrument(*args):
            """LSEG SDK callback params vary by version:
               v1: (fields, instrument_name, stream)
               v2: (stream, instrument_name, fields)
            Detect which param has the field data vs the stream object."""
            instrument = None
            fields_obj = None
            for p in args:
                if isinstance(p, str):
                    instrument = p
                elif fields_obj is None and not hasattr(p, 'universe') and type(p).__name__ != 'Stream':
                    # Not a stream → likely the fields/updates data
                    fields_obj = p
            # Fallback: if all non-string params look like streams, try the first one
            if fields_obj is None:
                for p in args:
                    if not isinstance(p, str):
                        fields_obj = p
                        break
            if instrument is None:
                instrument = str(args[1]) if len(args) > 1 else "unknown"
            return instrument, fields_obj

        def _on_upd(*args):
            _tick_count["update"] += 1
            instrument, raw_fields = _find_fields_and_instrument(*args)
            if _tick_count["update"] <= 5:
                log.info("[TICK] %s on_update #%d for %s: raw_type=%s, all_types=%s",
                         tag, _tick_count["update"], instrument,
                         type(raw_fields).__name__,
                         [type(a).__name__ for a in args])
                try:
                    extracted = _extract_fields(raw_fields)
                    log.info("[TICK] %s %s extracted: %s", tag, instrument,
                             {k: v for k, v in extracted.items() if v is not None})
                except Exception as e:
                    log.warning("[TICK] %s %s extract failed: %s", tag, instrument, e)
            try:
                on_update(instrument, _extract_fields(raw_fields))
            except Exception as e:
                log.exception("on_update error %s: %s", instrument, e)

        def _on_ref(*args):
            _tick_count["refresh"] += 1
            instrument, raw_fields = _find_fields_and_instrument(*args)
            log.info("[REFRESH] %s %s (#%d): raw_type=%s, all_types=%s",
                     tag, instrument, _tick_count["refresh"],
                     type(raw_fields).__name__,
                     [type(a).__name__ for a in args])
            try:
                extracted = _extract_fields(raw_fields)
                log.info("[REFRESH] %s %s data: %s", tag, instrument,
                         {k: v for k, v in extracted.items() if v is not None})
            except Exception as e:
                log.warning("[REFRESH] %s %s extract failed: %s", tag, instrument, e)
            handler = on_refresh or on_update
            try:
                handler(instrument, _extract_fields(raw_fields))
            except Exception as e:
                log.exception("on_refresh error %s: %s", instrument, e)

        def _on_status(*args):
            log.info("[STATUS] %s args=%s", tag, [str(a)[:200] for a in args])

        def _on_error(*args):
            log.error("[ERROR] %s args=%s", tag, [str(a)[:200] for a in args])

        def _on_complete(*args):
            log.info("[COMPLETE] %s stream completed, args=%s", tag, [str(a)[:200] for a in args])

        stream.on_update(_on_upd)
        stream.on_refresh(_on_ref)
        # Register status/error/complete if the SDK supports them
        if hasattr(stream, 'on_status'):
            stream.on_status(_on_status)
        if hasattr(stream, 'on_error'):
            stream.on_error(_on_error)
        if hasattr(stream, 'on_complete'):
            stream.on_complete(_on_complete)

        stream.open()
        with self._lock:
            self._streams[tag] = stream
        log.info("Stream '%s' opened for %d RICs: %s", tag, len(rics), rics)
        return stream

    def unsubscribe(self, tag: str) -> None:
        with self._lock:
            stream = self._streams.pop(tag, None)
        if stream:
            try: stream.close()
            except Exception as e: log.warning("close %s: %s", tag, e)

    def is_open(self) -> bool:
        return self._session is not None

    # ────────────────── IPA (analytics) ──────────────────
    def calc_fx_implied_yield(
        self,
        ccy_pair: str,
        spot: float,
        fwd_points: float,
        tenor_days: int,
        sofr_rate: float,
    ) -> Optional[float]:
        """
        Attempt to use LSEG IPA (Instrument Pricing Analytics) to compute
        implied yield for an FX forward.

        Falls back to None if IPA is unavailable (caller should use local calc).
        """
        try:
            import lseg.data as ld
            resp = ld.content.ipa.financial_contracts.Definition(
                instrument_type="FxCross",
                instrument_definition={
                    "instrumentCode": ccy_pair,
                    "legs": [{
                        "dealType": "FxForward",
                        "fxForwardType": "FxOutright",
                        "forwardTenor": f"{tenor_days}D",
                        "forwardPoints": fwd_points,
                    }],
                },
                pricing_parameters={
                    "valuationDate": datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z"),
                    "spotRate": spot,
                    "riskFreeRatePercent": sofr_rate,
                },
                fields=[
                    "ImpliedYieldPercent",
                    "ForwardRate",
                    "ImpliedDiscountFactor",
                ],
            ).get_data()
            if resp and hasattr(resp, "data") and resp.data:
                iy = resp.data.df.get("ImpliedYieldPercent")
                if iy is not None and len(iy) > 0:
                    return float(iy.iloc[0])
        except Exception as e:
            log.debug("IPA calc_fx_implied_yield failed (expected if IPA not available): %s", e)
        return None

    # ─────── new IPA forward API (via cross.Definition) ───────
    def _detect_kind(self, ccy_pair: str) -> str:
        """Detect NDF vs DELIVERABLE from CURRENCIES config."""
        try:
            from ric_config import CURRENCIES
            code = ccy_pair.replace("USD", "")
            cfg = CURRENCIES.get(code)
            if cfg is not None:
                return cfg.kind
        except Exception:
            pass
        return "DELIVERABLE"

    def _fwd_batch(
        self,
        ccy_pair: str,
        legs_spec: List[Dict[str, Any]],   # each: {"key": str, "tenor"?: str, "start_date"?: str, "end_date"?: str}
        kind: Optional[str] = None,
    ) -> Dict[str, Optional[Dict[str, Any]]]:
        """
        Core IPA call using cross.Definition. Returns {key: entry-dict or None}.
        entry: {startDate, endDate, fixDate, days, fwdPoints, fwdRate, impliedYield, source}
        """
        out: Dict[str, Optional[Dict[str, Any]]] = {s["key"]: None for s in legs_spec}
        if not legs_spec:
            return out
        try:
            from lseg.data.content.ipa.financial_contracts import cross
        except Exception as e:
            log.info("IPA cross import failed: %s", e)
            return out

        k = kind or self._detect_kind(ccy_pair)
        fx_cross_type = (cross.FxCrossType.FX_NON_DELIVERABLE_FORWARD
                         if k == "NDF" else cross.FxCrossType.FX_FORWARD)

        def _iso(v):
            try:
                import pandas as pd
                if v is None or pd.isna(v):
                    return None
            except Exception:
                if v is None:
                    return None
            if hasattr(v, "isoformat"):
                try:
                    s = v.isoformat()
                    return s[:10] if "T" in s else s
                except Exception:
                    return None
            s = str(v)
            if s in ("NaT", "nan", "None", "<NA>"):
                return None
            return s[:10] if len(s) >= 10 else s

        def _num(v):
            try:
                import pandas as pd
                if v is None or pd.isna(v):
                    return None
            except Exception:
                if v is None:
                    return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        # SDK collapses multi-leg batches to one row on this version; parallel per-leg.
        from datetime import date as _date
        from concurrent.futures import ThreadPoolExecutor, as_completed

        def _one(spec):
            kw: Dict[str, Any] = {"fx_leg_type": cross.FxLegType.FX_FORWARD}
            if spec.get("tenor"):      kw["tenor"] = spec["tenor"]
            if spec.get("start_date"): kw["start_date"] = spec["start_date"]
            if spec.get("end_date"):   kw["end_date"] = spec["end_date"]
            try:
                resp = cross.Definition(
                    fx_cross_code=ccy_pair,
                    fx_cross_type=fx_cross_type,
                    legs=[cross.LegDefinition(**kw)],
                    fields=["ForwardPoints", "FixingDate", "StartDate", "EndDate",
                            "DaysToExpiry", "ForwardRate", "ImpliedYieldPercent"],
                ).get_data()
            except Exception as e:
                log.info("IPA leg %s failed: %s", spec, e)
                return spec["key"], None
            if not resp or not hasattr(resp, "data") or resp.data is None:
                return spec["key"], None
            try:
                df = resp.data.df
            except Exception:
                return spec["key"], None
            if df is None or len(df) == 0:
                return spec["key"], None
            row = df.iloc[0]
            sd = _iso(row.get("StartDate"))
            ed = _iso(row.get("EndDate"))
            fd = _iso(row.get("FixingDate"))
            days = None
            if sd and ed:
                try:
                    d0 = _date.fromisoformat(sd); d1 = _date.fromisoformat(ed)
                    days = (d1 - d0).days
                except Exception:
                    days = None
            if days is None:
                dte = _num(row.get("DaysToExpiry"))
                days = int(dte) if dte is not None else None
            entry = {
                "startDate": sd, "endDate": ed, "valueDate": ed, "fixDate": fd,
                "days": days,
                "fwdPoints":    _num(row.get("ForwardPoints")),
                "fwdRate":      _num(row.get("ForwardRate")),
                "impliedYield": _num(row.get("ImpliedYieldPercent")),
                "tenor": spec.get("tenor"), "source": "IPA",
            }
            if entry["endDate"] is None and entry["fwdPoints"] is None and entry["fwdRate"] is None:
                return spec["key"], None
            return spec["key"], entry

        with ThreadPoolExecutor(max_workers=min(16, len(legs_spec))) as ex:
            for k, v in ex.map(_one, legs_spec):
                out[k] = v
        return out

    def calc_fx_forward(
        self,
        ccy_pair: str,
        tenor: str,
        valuation_date: Optional[str] = None,
        kind: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Use LSEG IPA to calculate forward points, outright, implied yield,
        fix date, and value date for ANY tenor on ANY currency pair.

        This is the PRIMARY source for non-anchor tenors. IPA uses Workspace's
        internal curve construction, holiday calendars, and market conventions
        — more accurate than manual interpolation.

        Args:
            ccy_pair:  e.g. "USDTWD", "USDSGD"
            tenor:     e.g. "1M", "3M", "45D", "6M", "1Y", "18M"
                       Accepts standard tenors or day-count tenors.
            valuation_date: ISO date string, defaults to today.

        Returns dict with keys:
            fwdPoints, fwdRate, impliedYield, fixDate, startDate, endDate, valueDate, days, tenor, source
        Or None if IPA is unavailable.
        """
        spec = {"key": tenor}
        if start_date or end_date:
            if start_date: spec["start_date"] = start_date
            if end_date: spec["end_date"] = end_date
        else:
            spec["tenor"] = tenor
        res = self._fwd_batch(ccy_pair, [spec], kind=kind).get(tenor)
        return res

    def calc_fx_forward_batch(
        self,
        ccy_pair: str,
        tenors: List[str],
        valuation_date: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> Dict[str, Optional[Dict[str, Any]]]:
        """Batch IPA call. {tenor: entry or None}."""
        specs = [{"key": t, "tenor": t} for t in tenors]
        return self._fwd_batch(ccy_pair, specs, kind=kind)

    def calc_fx_forward_custom_batch(
        self,
        ccy_pair: str,
        legs: List[Dict[str, Any]],   # each: {key, tenor?, start_date?, end_date?}
        kind: Optional[str] = None,
    ) -> Dict[str, Optional[Dict[str, Any]]]:
        """Batch call supporting explicit start/end dates per leg."""
        return self._fwd_batch(ccy_pair, legs, kind=kind)

    def calc_tomfix_plus_1bd(
        self,
        ccy_pair: str,
        kind: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Return TOMFIX x (1M+1bd) near/far legs with IPA business-day-adjusted dates.
          near = TN-tenor leg (TOMFIX value date)
          far  = 1M-leg-endDate + 1 calendar day, snapped to next business day by IPA

        Returns {near: {startDate,endDate,days}, far: {startDate,endDate,days}} or None.
        """
        # Step 1: resolve TN + 1M
        first = self._fwd_batch(
            ccy_pair,
            [{"key": "TN", "tenor": "TN"}, {"key": "1M", "tenor": "1M"}],
            kind=kind,
        )
        tn = first.get("TN")
        onem = first.get("1M")
        if not tn or not onem or not onem.get("startDate") or not onem.get("endDate"):
            return None
        # Step 2: far leg = start=1M.startDate, end=1M.endDate+1 calendar day
        try:
            from datetime import date as _date, timedelta as _td
            end1m = _date.fromisoformat(onem["endDate"])
            target_end = (end1m + _td(days=1)).isoformat()
        except Exception:
            return None
        far = self._fwd_batch(
            ccy_pair,
            [{"key": "FAR", "start_date": onem["startDate"], "end_date": target_end}],
            kind=kind,
        ).get("FAR")
        if not far:
            return None

        # near_days measured from today; far_days likewise (backend valuation date)
        from datetime import date as _date
        today = _date.today()
        def _d_from_today(iso):
            try:
                return (_date.fromisoformat(iso) - today).days
            except Exception:
                return None

        return {
            "near": {
                "startDate": tn.get("startDate"),
                "endDate": tn.get("endDate"),
                "days": tn.get("days"),
                "nearDays": _d_from_today(tn.get("endDate")),
            },
            "far": {
                "startDate": far.get("startDate"),
                "endDate": far.get("endDate"),
                "days": far.get("days"),
                "farDays": _d_from_today(far.get("endDate")),
            },
            "nearDays": _d_from_today(tn.get("endDate")),
            "farDays": _d_from_today(far.get("endDate")),
            "nearDate": tn.get("endDate"),
            "farDate": far.get("endDate"),
        }

