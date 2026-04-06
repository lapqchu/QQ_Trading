# FX Dashboard — Workspace Python API edition

Backend-driven FX dashboard for Asia NDFs + EMEA/Asia deliverables.
Runs locally on any PC with LSEG Workspace installed.

**Currencies covered**
- **NDFs** (7): USDTWD, USDKRW, USDINR, USDIDR, USDPHP, USDCNY, USDMYR
- **Deliverables** (5): USDCNH, USDSGD, USDTHB, USDKZT, USDRUB

## Architecture

```
 Workspace app  ←──  backend (FastAPI + lseg-data)  ──REST+WS──→  React frontend (vite)
                     port 8000                                    port 5173
```

- **Backend** opens a desktop session to Workspace via `lseg-data` SDK.
- Snapshot endpoint serves one-shot pulls (on load, on ccy-switch, or manual refresh).
- Three WebSocket channels fan out live ticks when the user enables live mode:
  - `/ws/spot`      → every tick (spot only)
  - `/ws/forwards`  → throttled to one tick per RIC per 15 s
  - `/ws/brokers`   → every tick from broker contributor RICs
- History endpoint is **only** fetched when the user clicks the Refresh button on the History tab.

## Setup

### 1. Install Workspace + generate App Key
1. Launch **LSEG Workspace** on the PC that will run the dashboard (same machine).
2. In Workspace, open **App Key Generator** → create a new key with the "Desktop Session" type.
3. Copy the key.

### 2. Backend
```bash
cd backend
python -m venv .venv
# Windows:   .venv\Scripts\activate
# macOS/Lin: source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env → set LSEG_APP_KEY=<your key>

uvicorn app:app --host 127.0.0.1 --port 8000
```
Verify with: `curl http://127.0.0.1:8000/api/status`

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```
Open `http://localhost:5173`.

The Vite dev server proxies `/api` and `/ws` to the backend, so both ports are in scope.

## Usage

- **CCY dropdown** — switches the active currency. Backend snapshot refetched, streams restart.
- **Snap button** — force-refresh the one-shot snapshot without touching live streams.
- **LIVE toggle** — opens/closes WS subscriptions. Spot ticks immediately; forwards update once per 15 s per RIC; broker streams tick-by-tick.
- **History tab** — click Refresh to pull historical bars (never auto-refreshed; data-heavy).

## Key files

| Path | Purpose |
|---|---|
| `backend/ric_config.py` | All per-currency configs, RIC formatters, spread packs |
| `backend/lseg_client.py` | Thin wrapper around `lseg-data` desktop session + streaming |
| `backend/market_service.py` | Snapshot + live-fanout orchestration, 15s forward throttle |
| `backend/app.py` | FastAPI REST + WS endpoints |
| `frontend/src/api.js` | REST + WS client |
| `frontend/src/useLive.js` | React hook merging snapshot + live quotes |
| `frontend/src/App.jsx` | Main dashboard UI |
| `frontend/src/calc.js` | Quant utilities (interpolation, implied yields, stats) |

## Notes

- **Broker RIC suffixes** are configured as `ICAP`, `BGCP`, `TRAD`, `TPTS` in `ric_config.BROKER_CONTRIBUTORS`. Verify these match what your Workspace session exposes; adjust if your desk's contributor set differs.
- **Deliverable forward points RICs** follow the convention `{CCY}{tenor}=` (e.g. `SGD1M=`). If your shop's convention differs (some desks use `USDSGD1M=` or `=D2` suffixes), adjust `CurrencyConfig.outright_ric()` in `ric_config.py`.
- **SOFR curve** is shared across currencies via the `SOFR_RICS` map.
- The LSEG MCP connector in Claude remains useful for quick RIC checks and validation during development.
