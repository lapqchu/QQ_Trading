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
from pydantic import BaseModel
from dotenv import load_dotenv

from lseg_client import LsegClient
from market_service import MarketService
from neer_service import NeerService, MAS_MEETINGS
from risk_service import RiskService, product_catalog
from carry_basket_service import CarryBasketService
from sg_fundamentals_service import SgFundamentalsService
from sg_inflation_model import SgInflationModel
from em_rules_service import EmRulesService
from ric_config import CURRENCIES, NDF_CURRENCIES, DELIVERABLE_CURRENCIES, get_spread_pack, get_spread_packs, FUNDING_TENORS

load_dotenv()
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("app")

# Globals wired in lifespan
lseg: LsegClient | None = None
market: MarketService | None = None
neer: NeerService | None = None
risk: RiskService | None = None
carry: CarryBasketService | None = None
fund: SgFundamentalsService | None = None
fund_model: SgInflationModel | None = None
rules: EmRulesService | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global lseg, market, neer, risk, carry, fund, fund_model, rules
    lseg = LsegClient(app_key=os.environ.get("LSEG_APP_KEY"))
    try:
        lseg.open()
    except Exception as e:
        log.error("Failed to open LSEG session: %s", e)
        log.error("Make sure Workspace is running and LSEG_APP_KEY is set in .env")
    market = MarketService(lseg)
    market.set_loop(asyncio.get_running_loop())
    neer = NeerService(lseg)   # SGD NEER deep-dive service (shares the LSEG session)
    risk = RiskService(lseg)   # Risk Units vol/sizing service
    carry = CarryBasketService(lseg)   # Carry Basket rank/sizing deep-dive service
    fund = SgFundamentalsService(lseg)  # SG Fundamentals country monitor (deep-dive tab 4)
    fund_model = SgInflationModel(lseg)  # SG inflation nowcast + Phillips curve (MODEL sub-tab)
    rules = EmRulesService(lseg)         # EM Rules screener (Willer/Chandran/Lam), tab 5
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
        snap["spreadPacks"] = _spread_packs_for(ccy)
        snap["lastReloadTs"] = time.time()
        return snap
    except Exception as e:
        log.exception("snapshot %s failed", ccy)
        raise HTTPException(500, str(e))


@app.get("/api/history/{ccy}")
def get_history(
    ccy: str,
    period: str = Query("1Y"),
    contributor: str | None = Query(None),
    extra_rics: str | None = Query(None, description="comma-separated RICs to include alongside composite"),
    tenor: str | None = Query(None, description="ON|TN|SN — if set, overrides RIC list with funding RICs for that tenor"),
) -> Dict[str, Any]:
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open")
    try:
        extras = [r.strip() for r in extra_rics.split(",")] if extra_rics else None
        return market.get_history(ccy, period=period, contributor=contributor, extra_rics=extras, tenor=tenor)
    except Exception as e:
        log.exception("history %s failed", ccy)
        raise HTTPException(500, str(e))


@app.post("/api/t1-backfill")
def t1_backfill(rics: str = Query(..., description="comma-separated RICs")) -> Dict[str, Any]:
    """Lazy T-1 fetch for a specific set of RICs (one Workspace call per
    uncached RIC, cached per-date). Called by frontend when a new broker
    source is ticked."""
    if not market:
        raise HTTPException(503, "market service not ready")
    ric_list = [r.strip() for r in rics.split(",") if r.strip()]
    if not ric_list:
        return {}
    return market.backfill_t1(ric_list)


@app.get("/api/history-custom/{ccy}")
def get_history_custom(
    ccy: str,
    near: str = Query(..., description="near date ISO YYYY-MM-DD"),
    far: str = Query(..., description="far date ISO YYYY-MM-DD"),
    period: str = Query("1Y"),
    contributor: str | None = Query(None),
) -> Dict[str, Any]:
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open")
    try:
        return market.get_history_custom_dates(ccy, near_date=near, far_date=far,
                                               period=period, contributor=contributor)
    except Exception as e:
        log.exception("history-custom %s failed", ccy)
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


@app.get("/api/ipa/forward")
def ipa_forward(
    pair: str = Query(..., description="Currency pair, e.g. USDTWD"),
    tenor: str = Query(..., description="Tenor, e.g. 1M, 45D, 3M, 1Y"),
) -> Dict[str, Any]:
    """
    Ask Workspace IPA to calculate forward points, outright, implied yield,
    fix/value dates for any arbitrary tenor on any pair.
    This is the PRIMARY source for non-anchor tenor values.
    """
    if not lseg or not lseg.is_open():
        return {"data": None, "source": "unavailable", "reason": "LSEG session not open"}
    result = lseg.calc_fx_forward(pair, tenor)
    if result:
        return {"data": result, "source": "IPA"}
    return {"data": None, "source": "unavailable", "reason": "IPA returned no data for this pair/tenor"}


@app.get("/api/ipa/forward-batch")
def ipa_forward_batch(
    pair: str = Query(..., description="Currency pair, e.g. USDTWD"),
    tenors: str = Query(..., description="Comma-separated tenors, e.g. 1W,2W,3W,45D"),
) -> Dict[str, Any]:
    """
    Batch IPA call — calculate forward data for multiple tenors at once.
    Used by snapshot pipeline and frontend tools.
    """
    if not lseg or not lseg.is_open():
        return {"data": {}, "source": "unavailable"}
    tenor_list = [t.strip() for t in tenors.split(",") if t.strip()]
    results = lseg.calc_fx_forward_batch(pair, tenor_list)
    return {"data": results, "source": "IPA"}


@app.get("/api/status")
def status() -> Dict[str, Any]:
    cooldown = lseg.cooldown_remaining() if lseg else 0.0
    return {
        "sessionOpen": lseg.is_open() if lseg else False,
        "activeCcy": market._active_ccy if market else None,
        "tickCounts": dict(market._tick_counts) if market else {},
        "wsSubscribers": {ch: len(subs) for ch, subs in (market._subscribers if market else {}).items()},
        # Circuit breaker: >0 means LSEG returned sustained 429s (rate/daily-quota) and
        # the backend is pausing calls. The frontend should stop polling until it clears.
        "lsegCooldownSec": round(cooldown, 1),
        "lsegThrottled": cooldown > 0,
    }


# ─────────────────────────── Risk Units ───────────────────────────
@app.get("/api/risk/products")
def risk_products(ccy: str = Query(...)) -> Dict[str, Any]:
    """Product catalogue for a currency (calculator dropdown)."""
    if ccy not in CURRENCIES:
        raise HTTPException(404, f"Unknown currency: {ccy}")
    return {"ccy": ccy, "products": product_catalog(ccy)}


@app.get("/api/risk/vol")
def risk_vol(ccy: str = Query(...), product: str = Query(...),
             window: int = Query(20)) -> Dict[str, Any]:
    """Daily vol + historical return distribution for one product (on-demand)."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return risk.vol(ccy, product, window)
    except Exception as e:
        log.exception("risk_vol failed")
        raise HTTPException(500, str(e))


# ─────────────────────────── Carry Basket ───────────────────────────
class _LongLeg(BaseModel):
    code: str
    notionalUsd: float = 0.0


class _BasketReq(BaseModel):
    longs: list[_LongLeg] = []
    shorts: list[str] = []
    sizingMode: str = "vol_neutral"     # vol_neutral | dollar_neutral
    weighting: str = "inverse_vol"      # inverse_vol | equal_notional
    window: int = 20


class _BasketHistReq(_BasketReq):
    years: int = 20


@app.get("/api/carry/rank")
def carry_rank(force: bool = Query(False)) -> Dict[str, Any]:
    """1M forward-implied yield rank across all EM (pricer) + G10 currencies."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return carry.rank(force=force)
    except Exception as e:
        log.exception("carry_rank failed")
        raise HTTPException(500, str(e))


@app.get("/api/carry/vols")
def carry_vols(codes: str = Query(...), window: int = Query(20)) -> Dict[str, Any]:
    """Per-currency daily/annual realized vol + downside percentiles."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        code_list = [c.strip().upper() for c in codes.split(",") if c.strip()]
        return {"window": window, "vols": carry.vols(code_list, window)}
    except Exception as e:
        log.exception("carry_vols failed")
        raise HTTPException(500, str(e))


@app.get("/api/carry/betas")
def carry_betas(window: int = Query(60)) -> Dict[str, Any]:
    """Rolling β of each currency's appreciation returns vs an equal-weight EM FX basket."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return carry.betas(window)
    except Exception as e:
        log.exception("carry_betas failed")
        raise HTTPException(500, str(e))


@app.post("/api/carry/basket_history")
def carry_basket_history(req: _BasketHistReq) -> Dict[str, Any]:
    """~20y monthly excess-return history of the currently sized basket (on demand —
    pulls multi-year daily histories per leg; cached 24h)."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        longs = [{"code": l.code.upper(), "notionalUsd": l.notionalUsd} for l in req.longs]
        shorts = [c.upper() for c in req.shorts]
        return carry.basket_history(longs, shorts, req.sizingMode, req.weighting,
                                    req.window, req.years)
    except Exception as e:
        log.exception("carry_basket_history failed")
        raise HTTPException(500, str(e))


@app.post("/api/carry/basket")
def carry_basket(req: _BasketReq) -> Dict[str, Any]:
    """Size the short leg vol-adjusted to balance user-specified longs; return the
    full book (per-name notionals, book vol from covariance, net carry, carry-to-vol)."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        longs = [{"code": l.code.upper(), "notionalUsd": l.notionalUsd} for l in req.longs]
        shorts = [c.upper() for c in req.shorts]
        return carry.basket(longs, shorts, req.sizingMode, req.weighting, req.window)
    except Exception as e:
        log.exception("carry_basket failed")
        raise HTTPException(500, str(e))


# ─────────────────────── SG Fundamentals (deep-dive tab 4) ───────────────────────
@app.get("/api/fund/sg")
def fund_sg(refresh: bool = False) -> Dict[str, Any]:
    """Singapore fundamentals monitor payload: inflation (+contributions), consensus,
    drivers, activity, labour, monetary, policy, release calendar. Cached 6h —
    the frontend fetches once on mount + manual refresh; do NOT poll this."""
    try:
        return fund.monitor(refresh=refresh)
    except Exception as e:
        log.exception("fund_sg failed")
        raise HTTPException(500, str(e))


@app.get("/api/fund/sg/model")
def fund_sg_model(refresh: bool = False) -> Dict[str, Any]:
    """SG inflation MODEL payload: next-print bottom-up nowcast (per-component,
    with driver methods), Phillips-curve fit/decomposition/projection, 36-month
    expanding backtest vs naive, and the policy reaction prior. Cached 6h."""
    try:
        return fund_model.model(refresh=refresh)
    except Exception as e:
        log.exception("fund_sg_model failed")
        raise HTTPException(500, str(e))


@app.get("/api/fund/sg/nowcast")
def fund_sg_nowcast(refresh: bool = False) -> Dict[str, Any]:
    """High-frequency Tier-A trackers that lead the CPI print: tariff-setting
    window (Brent proxy), COE bidding, FAO food, HDB rents, jet fuel. Cached 6h."""
    try:
        return fund.nowcast(refresh=refresh)
    except Exception as e:
        log.exception("fund_sg_nowcast failed")
        raise HTTPException(500, str(e))


@app.get("/api/rules")
def em_rules(refresh: bool = False) -> Dict[str, Any]:
    """EM Rules screener payload: per-country rule states (R1–R5, R8, R11) +
    global overlays (R6/R9/R10). Cached 12h — one build per day is the intent;
    do NOT poll. R7 carry/vol is served by /api/carry/rank."""
    try:
        return rules.build(refresh=refresh)
    except Exception as e:
        log.exception("em_rules failed")
        raise HTTPException(500, str(e))


# ─────────────────────────── NEER deep-dive (SGD) ───────────────────────────
@app.get("/api/neer/sgd")
def neer_sgd() -> Dict[str, Any]:
    """Live SGD NEER snapshot: index, band position, per-leg contributions, SORA,
    carry, and trading metrics."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return neer.build_sgd()
    except Exception as e:
        log.exception("neer_sgd failed")
        raise HTTPException(500, str(e))


@app.get("/api/neer/sgd/history")
def neer_sgd_history() -> Dict[str, Any]:
    """NEER index history + crawling policy band (for the band chart)."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        s = neer.neer_series()
        return {"dates": s.get("dates", []), "neer": s.get("neer", []),
                "midpoint": s.get("midpoint", []), "upper": s.get("upper", []),
                "lower": s.get("lower", []), "posBp": s.get("posBp", []),
                "meetings": MAS_MEETINGS}
    except Exception as e:
        log.exception("neer_sgd_history failed")
        raise HTTPException(500, str(e))


@app.get("/api/neer/sgd/intraday")
def neer_sgd_intraday(window: str = Query("1d", description="1d|3d|5d|20d")) -> Dict[str, Any]:
    """Intraday live NEER series (tick chart) for the selected window."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return neer.intraday_neer(window)
    except Exception as e:
        log.exception("neer_sgd_intraday failed")
        raise HTTPException(500, str(e))


@app.get("/api/neer/sgd/analysis")
def neer_sgd_analysis() -> Dict[str, Any]:
    """Strategy scan: mean-reversion / trend signals + backtest on the band position."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return neer.analysis()
    except Exception as e:
        log.exception("neer_sgd_analysis failed")
        raise HTTPException(500, str(e))


@app.get("/api/neer/sgd/calibration")
def neer_sgd_calibration() -> Dict[str, Any]:
    """Replica-vs-official calibration: tracking error, correlation, and a
    constrained-LSQ weight refit (gated on fit quality)."""
    if not lseg or not lseg.is_open():
        raise HTTPException(503, "LSEG session not open — check Workspace app & APP_KEY")
    try:
        return neer.calibration()
    except Exception as e:
        log.exception("neer_sgd_calibration failed")
        raise HTTPException(500, str(e))


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
    except asyncio.CancelledError:
        log.debug("WS %s cancelled (shutdown)", channel)
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
def _row_to_dict(row):
    label, near, far, nl, fl = row
    return {"label": label, "near": near, "far": far, "nearLabel": nl, "farLabel": fl}


def _spread_defs_for(ccy: str):
    """Return JSON-friendly flat spread pack definitions (back-compat)."""
    return [_row_to_dict(row) for row in get_spread_pack(ccy)]


def _spread_packs_for(ccy: str):
    """Return JSON-friendly grouped packs dict.

    Shape:
      {
        fullCurve:    {spotStart: [...], m1Chain: [...], m3Chain: [...]},
        spreadsRolls: {interbankAnchors?: [...], imm: [...]}
      }
    """
    packs = get_spread_packs(ccy)
    out = {}
    for group, subpacks in packs.items():
        out[group] = {k: [_row_to_dict(r) for r in v] for k, v in subpacks.items()}
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", 8000)),
        reload=False,
    )
