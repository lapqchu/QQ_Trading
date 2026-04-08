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
        kwargs: Dict[str, Any] = {"universe": rics, "fields": list(fields), "interval": interval}
        if start: kwargs["start"] = start
        if end: kwargs["end"] = end
        if count: kwargs["count"] = count
        df = ld.get_history(**kwargs)
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

        def _on_upd(item, instrument, updates):
            try: on_update(instrument, updates)
            except Exception as e: log.exception("on_update error %s: %s", instrument, e)

        def _on_ref(item, instrument, fields_):
            handler = on_refresh or on_update
            try: handler(instrument, fields_)
            except Exception as e: log.exception("on_refresh error %s: %s", instrument, e)

        stream.on_update(_on_upd)
        stream.on_refresh(_on_ref)
        stream.open()
        with self._lock:
            self._streams[tag] = stream
        log.info("Stream '%s' opened for %d RICs", tag, len(rics))
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

    def calc_fx_forward(
        self,
        ccy_pair: str,
        tenor: str,
        valuation_date: Optional[str] = None,
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
            fwdPoints, fwdRate, impliedYield, fixDate, valueDate, tenor, source
        Or None if IPA is unavailable.
        """
        try:
            import lseg.data as ld
            val_date = valuation_date or datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")

            # Do NOT pass forwardPoints — let IPA compute from its internal curve
            resp = ld.content.ipa.financial_contracts.Definition(
                instrument_type="FxCross",
                instrument_definition={
                    "instrumentCode": ccy_pair,
                    "legs": [{
                        "dealType": "FxForward",
                        "fxForwardType": "FxOutright",
                        "forwardTenor": tenor,
                    }],
                },
                pricing_parameters={
                    "valuationDate": val_date,
                },
                fields=[
                    "ForwardPoints",
                    "ForwardRate",
                    "ImpliedYieldPercent",
                    "FixingDate",
                    "EndDate",
                    "StartDate",
                    "DaysToExpiry",
                    "FxSpotRate",
                ],
            ).get_data()

            if not resp or not hasattr(resp, "data") or not resp.data:
                return None

            df = resp.data.df
            result = {}
            for col in ["ForwardPoints", "ForwardRate", "ImpliedYieldPercent",
                        "FixingDate", "EndDate", "StartDate", "DaysToExpiry", "FxSpotRate"]:
                val = df.get(col)
                if val is not None and len(val) > 0:
                    v = val.iloc[0]
                    # Convert pandas Timestamp to ISO string for dates
                    if hasattr(v, 'isoformat'):
                        result[col] = v.isoformat()
                    elif v is not None and str(v) != 'nan':
                        result[col] = float(v)
                    else:
                        result[col] = None
                else:
                    result[col] = None

            # Only return if we got at least forward points or rate
            if result.get("ForwardPoints") is None and result.get("ForwardRate") is None:
                log.debug("IPA returned no ForwardPoints/ForwardRate for %s %s", ccy_pair, tenor)
                return None

            return {
                "fwdPoints": result.get("ForwardPoints"),
                "fwdRate": result.get("ForwardRate"),
                "impliedYield": result.get("ImpliedYieldPercent"),
                "fixDate": result.get("FixingDate"),
                "valueDate": result.get("EndDate"),
                "startDate": result.get("StartDate"),
                "days": result.get("DaysToExpiry"),
                "spotRate": result.get("FxSpotRate"),
                "tenor": tenor,
                "source": "IPA",
            }
        except Exception as e:
            log.debug("IPA calc_fx_forward(%s, %s) failed: %s", ccy_pair, tenor, e)
        return None

    def calc_fx_forward_batch(
        self,
        ccy_pair: str,
        tenors: List[str],
        valuation_date: Optional[str] = None,
    ) -> Dict[str, Optional[Dict[str, Any]]]:
        """
        Batch IPA call for multiple tenors on one pair.
        Returns {tenor: result_dict or None}.
        """
        results = {}
        # Try batch via multiple legs in one call first
        try:
            import lseg.data as ld
            val_date = valuation_date or datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")

            legs = []
            for t in tenors:
                legs.append({
                    "dealType": "FxForward",
                    "fxForwardType": "FxOutright",
                    "forwardTenor": t,
                })

            resp = ld.content.ipa.financial_contracts.Definition(
                instrument_type="FxCross",
                instrument_definition={
                    "instrumentCode": ccy_pair,
                    "legs": legs,
                },
                pricing_parameters={
                    "valuationDate": val_date,
                },
                fields=[
                    "ForwardPoints", "ForwardRate", "ImpliedYieldPercent",
                    "FixingDate", "EndDate", "StartDate", "DaysToExpiry", "FxSpotRate",
                ],
            ).get_data()

            if resp and hasattr(resp, "data") and resp.data:
                df = resp.data.df
                # Multi-leg response: each row corresponds to a leg
                for i, t in enumerate(tenors):
                    if i < len(df):
                        row = df.iloc[i]
                        entry = {}
                        for col in ["ForwardPoints", "ForwardRate", "ImpliedYieldPercent",
                                    "FixingDate", "EndDate", "StartDate", "DaysToExpiry", "FxSpotRate"]:
                            v = row.get(col) if hasattr(row, 'get') else getattr(row, col, None)
                            if v is not None and hasattr(v, 'isoformat'):
                                entry[col] = v.isoformat()
                            elif v is not None and str(v) != 'nan':
                                try:
                                    entry[col] = float(v)
                                except (TypeError, ValueError):
                                    entry[col] = str(v)
                            else:
                                entry[col] = None

                        if entry.get("ForwardPoints") is not None or entry.get("ForwardRate") is not None:
                            results[t] = {
                                "fwdPoints": entry.get("ForwardPoints"),
                                "fwdRate": entry.get("ForwardRate"),
                                "impliedYield": entry.get("ImpliedYieldPercent"),
                                "fixDate": entry.get("FixingDate"),
                                "valueDate": entry.get("EndDate"),
                                "startDate": entry.get("StartDate"),
                                "days": entry.get("DaysToExpiry"),
                                "spotRate": entry.get("FxSpotRate"),
                                "tenor": t,
                                "source": "IPA",
                            }
                        else:
                            results[t] = None
                    else:
                        results[t] = None
                return results

        except Exception as e:
            log.debug("IPA batch failed for %s, falling back to individual calls: %s", ccy_pair, e)

        # Fallback: individual calls
        for t in tenors:
            results[t] = self.calc_fx_forward(ccy_pair, t, valuation_date)
        return results
