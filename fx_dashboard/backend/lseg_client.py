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
