"""
FastAPI app — FX dashboard backend.

Endpoints:
  REST
    GET  /api/currencies                    → list of available currencies with metadata
    GET  /api/snapshot/{ccy}                → full snapshot (spot + tenors + SOFR)
    GET  /api/history/{ccy}?days=60         → historical bars (on demand)
    POST /api/live/start?ccy=TWD            → begin streaming for a currency
    POST /api/live/stop?ccy=TWD             → stop streaming
    GET  /api/status                        → session & stream status

  WebSocket
    /ws/spot                                 → every tick (spot only)
    /ws/forwards                             → one tick per RIC per 15s
    /ws/brokers                              → every broker tick

Run:   uvicorn app:app --host 127.0.0.1 --port 8000 --reload
"""

from __future__ import annotations
import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from lseg_client import LsegClient
from market_service import MarketService
from ric_config import CURRENCIES, NDF_CURRENCIES, DELIVERABLE_CURRENCIES, get_spread_pack

load_dotenv()
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("app")

# Globals wired in lifespan
lseg: LsegClient | None = None
market: MarketService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global lseg, market
    lseg = LsegClient(app_key=os.environ.get("LSEG_APP_KEY"))
    try:
        lseg.open()
    except Exception as e:
        log.error("Failed to open LSEG session: %s", e)
        log.error("Make sure Workspace is running and LSEG_APP_KEY is set in .env")
    market = MarketService(lseg)
    market.set_loop(asyncio.get_running_loop())
    log.info("FX dashboard backend ready")
    yield
    log.info("Shutting down")
    try:
        market.stop_streams()
    except Exception: pass
    try:
        lseg.close()
    except Exception: pass


app = FastAPI(title="FX Dashboard Backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000"],
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


# ─────────────────────────── REST ───────────────────────────
@app.get("/api/currencies")
def list_currencies() -> Dict[str, Any]:
    return {
        "ndfs": NDF_CURRENCIES,
        "deliverables": DELIVERABLE_CURRENCIES,
        "meta": {
            code: {
                "pair": cfg.pair, "kind": cfg.kind,
                "pipFactor": cfg.pip_factor, "outrightDp": cfg.outright_dp,
                "pipDp": cfg.pip_dp, "tenorsM": cfg.anchor_tenors_m, "maxDisplayM": cfg.max_display_m,
                "spreadPack": cfg.spread_pack,
            } for code, cfg in CURRENCIES.items()
        },
    }


@app.get("/api/snapshot/{ccy}")
def get_snapshot(ccy: str) -> Dict[str, Any]:
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        snap = market.build_snapshot(ccy)
        snap["spreadDefs"] = _spread_defs_for(ccy)
        snap["lastReloadTs"] = time.time()
        return snap
    except Exception as e:
        log.exception("snapshot %s failed", ccy)
        raise HTTPException(500, str(e))


@app.get("/api/history/{ccy}")
def get_history(ccy: str, days: int = Query(60, ge=10, le=500)) -> Dict[str, Any]:
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open")
    try:
        return market.get_history(ccy, days=days)
    except Exception as e:
        log.exception("history %s failed", ccy)
        raise HTTPException(500, str(e))


@app.post("/api/live/start")
def live_start(ccy: str) -> Dict[str, Any]:
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    market.stop_streams()  # switch away from previous
    market.start_streams(ccy)
    return {"status": "streaming", "ccy": ccy}


@app.post("/api/live/stop")
def live_stop(ccy: str | None = None) -> Dict[str, Any]:
    market.stop_streams(ccy)
    return {"status": "stopped", "ccy": ccy}


@app.get("/api/ipa/implied-yield")
def ipa_implied_yield(
    pair: str = Query(...),
    spot: float = Query(...),
    fwd_points: float = Query(...),
    days: int = Query(...),
    sofr: float = Query(0.0),
) -> Dict[str, Any]:
    """Try LSEG IPA for implied yield; returns null if unavailable (frontend falls back to local calc)."""
    if not lseg or not lseg.is_open():
        return {"iy": None, "source": "unavailable"}
    iy = lseg.calc_fx_implied_yield(pair, spot, fwd_points, days, sofr)
    if iy is not None:
        return {"iy": iy, "source": "LSEG_IPA"}
    return {"iy": None, "source": "unavailable"}


@app.get("/api/status")
def status() -> Dict[str, Any]:
    return {
        "sessionOpen": lseg.is_open() if lseg else False,
        "activeCcy": market._active_ccy if market else None,
    }


# ─────────────────────────── WebSockets ───────────────────────────
async def _stream_channel(ws: WebSocket, channel: str):
    await ws.accept()
    q = market.subscribe_channel(channel)
    try:
        while True:
            msg = await q.get()
            await ws.send_json({"channel": channel, "data": msg})
    except WebSocketDisconnect:
        log.debug("WS %s disconnected", channel)
    except Exception as e:
        log.warning("WS %s error: %s", channel, e)
    finally:
        market.unsubscribe_channel(channel, q)


@app.websocket("/ws/spot")
async def ws_spot(ws: WebSocket):
    await _stream_channel(ws, "spot")


@app.websocket("/ws/forwards")
async def ws_forwards(ws: WebSocket):
    await _stream_channel(ws, "forwards")


@app.websocket("/ws/brokers")
async def ws_brokers(ws: WebSocket):
    await _stream_channel(ws, "brokers")


# ─────────────────────────── helpers ───────────────────────────
def _spread_defs_for(ccy: str):
    """Return JSON-friendly spread pack definitions."""
    pack = get_spread_pack(ccy)
    return [
        {"label": label, "near": near, "far": far, "nearLabel": nl, "farLabel": fl}
        for label, near, far, nl, fl in pack
    ]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 8000)),
        reload=False,
    )
