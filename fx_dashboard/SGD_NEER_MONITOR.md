# SGD NEER Monitor — how to run (company PC)

A deep-dive dashboard for the Singapore dollar: reconstructs the MAS S$NEER live from
the basket legs, overlays the estimated policy band, the SORA rates complex, carry, and
trading-signal metrics. It runs on the **same backend and dev server as the FX pricer** —
just a different page.

## Prerequisites
- **LSEG Workspace** running and logged in on the PC (the backend uses the local desktop
  session on port 9000). No IPA entitlement needed.
- `backend/.env` with your app key:
  ```
  LSEG_APP_KEY=<your key>
  HOST=127.0.0.1
  PORT=8000
  ```
- Python 3.11+ and Node 18+.

## 1. Backend (terminal 1)
```
cd fx_dashboard/backend
python -m venv .venv && source .venv/bin/activate     # first time (Windows: .venv\Scripts\activate)
pip install -r requirements.txt                        # first time (adds scipy for the weight-fit)
uvicorn app:app --host 127.0.0.1 --port 8000
```
Wait for `FX dashboard backend ready`. (No `--reload`.)

## 2. Frontend (terminal 2)
```
cd fx_dashboard/frontend
npm install                                            # first time
npm run dev
```
Then open in the browser:
- **SGD NEER monitor:  http://localhost:5173/neer.html**
- FX pricer (unchanged): http://localhost:5173/

That's it — the NEER page polls the backend every ~8s and ticks live with the FX legs.

The page has two tabs: **MONITOR** and **ANALYSIS**.

### MONITOR
- **NEER + band position** — our live geometric replica of the MAS S$NEER, re-based to the
  **official MAS weekly series (`aSGDEOP`, ~141)** so it reads the market level, and where it
  sits in the estimated ±2% policy band (bp above/below the crawling midpoint). Near the ceiling
  = rich / limited upside; near the floor = cheap.
- **Live intraday chart** — tick-by-tick S$NEER with a **1D / 3D / 5D / 20D** toggle.
- **Band history chart** — NEER vs the crawling band, with **MAS meeting markers annotated by
  what MAS did** (ease / tighten / hold / re-centre).
- **Basket** — Barclays weights (CNH for the China leg), each leg's live bilateral and its
  contribution to today's NEER move (bp).
- **SORA OIS curve** — the market SORA OIS curve (`SGDSRA<T>OIS=`, O/N–30Y, matches Bloomberg),
  the O/N SORA OIS (`SGDSRAONOIS=TRDS`) and the O/N fixing (`SORA=MAST`). (SOR is discontinued, so
  the SOR/SORA basis was dropped.)
- **Carry** — forward NEER − spot NEER at 1M/2M/3M/6M/1Y (forward built from each leg's forward
  outright; NDF-implied spot for NDF legs). Net carry = policy slope − forward-priced appreciation
  (negative ⇒ costs carry to be long the band).
- **Trading metrics** — band-position z-score & percentile, distance-to-ceiling in bp and in σ,
  realized vol, 20/50 MA deviation, carry-to-vol.
- **Calibration** — tracking error / correlation / r² of our replica vs the official **aSGDEOP**
  weekly series (r²≈0.97, TE≈5bp), plus a constrained-LSQ weight refit.

### ANALYSIS (brief-scan strategy signals)
- **Mean reversion** on the band position (the master series): Bollinger/z-score ±2σ with buy/sell
  markers; **trend** via 20/50 MA on the detrended series.
- **Backtest** of the mean-reversion strategy: equity curve, rolling Sharpe, total/annual return,
  max drawdown, hit rate. Research-informed defaults; band params are model estimates.

## Data-source notes (important)
- **Everything on the page is live from LSEG** (FX legs, SORA OIS curve, forward points) — no
  dependency on the MAS website. The displayed NEER level is re-based to the official MAS weekly
  series **`aSGDEOP`** (LSEG economic indicator, ~141, weekly with ~1-month publication lag).
- **Band parameters (slope schedule, width ±2%, +166bp anchor) are STREET ESTIMATES**, not
  disclosed by MAS. They live in `backend/neer_service.py` (`SLOPE_SCHEDULE`, `BAND_WIDTH`,
  `BAND_ANCHOR_*`, `MAS_MEETING_ACTIONS`) — edit them as your view changes.
- **Weights are Barclays' published set** (editable in `neer_service.py` `BASKET`). The calibration
  panel fits weights to the **official aSGDEOP** series (month-averaged): **r²≈0.97, TE≈5bp**.
- **Analysis-tab band params are model estimates** of undisclosed MAS parameters; treat MAS meeting
  dates (Jan/Apr/Jul/Oct) as hard event boundaries.

## Verified at build (2026-07-30, live — 14/14 audit)
NEER **141.75** (official aSGDEOP 141.47, within 0.2%); band position ≈ +169bp; SORA O/N OIS 1.24,
1M OIS **1.225** (Bloomberg ~1.23), 2Y 1.67; net carry **−0.6%/yr** (Barclays negative-carry
framing); calibration vs aSGDEOP weekly **r²=0.974, TE 5.4bp**; realized NEER vol ~1.8%/yr;
mean-reversion backtest Sharpe ~2.0, maxDD ~−0.5%.
