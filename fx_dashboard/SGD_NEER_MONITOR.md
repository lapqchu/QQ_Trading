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

## What you're looking at
- **NEER + band position** — our live geometric replica of the MAS S$NEER, and where it sits
  in the estimated ±2% policy band (bp above/below the crawling midpoint). Near the ceiling =
  rich / limited upside; near the floor = cheap.
- **Band history chart** — NEER vs the crawling band, with MAS meeting markers.
- **Basket** — Barclays weights (CNH used for the China leg), each leg's live bilateral and its
  contribution to today's NEER move (bp).
- **SORA** — live O/N SORA (`SORA=MAST`), self-compounded 1M/3M, the full SORA OIS curve
  (`SGDSRA<T>OIS=`, 1M–30Y), and the legacy SOR/SORA basis.
- **Carry** — policy slope minus the forward-implied SGD appreciation (negative = costs carry
  to be long the band).
- **Trading metrics** — band-position z-score & percentile, distance-to-ceiling in bp and in σ,
  realized vol, 20/50 MA deviation, carry-to-vol.
- **Calibration** — tracking error / correlation / r² of our replica vs an official NEER series.

## Data-source notes (important)
- **Everything on the page is live from LSEG** (FX legs, SORA cash + OIS). No dependency on the
  MAS website.
- **Band parameters (slope 1.25%/yr, width ±2%, +166bp anchor) are STREET ESTIMATES**, not
  disclosed by MAS. They live in `backend/neer_service.py` (`SLOPE_SCHEDULE`, `BAND_WIDTH`,
  `BAND_ANCHOR_*`) — edit them as your view changes.
- **Weights are Barclays' published set** (also editable in `neer_service.py` `BASKET`). The
  calibration panel additionally fits weights to an official NEER proxy (r²≈0.96 vs the LSEG
  monthly Singapore-NEER series).
- **bp-precise calibration vs the true MAS *weekly* S$NEER** activates automatically once the
  MAS eServices API is reachable (it was under maintenance at build time). Until then the band
  is anchored to the latest published street position and validated against the monthly proxy.

## Verified at build (2026-07-28/29, live)
NEER position ≈ +157bp (Barclays note +166, post-MPS dip); SORA O/N 1.06%, 2Y SORA OIS 1.69%
(Barclays ~1.70); compounded 3M SORA 1.12% (Barclays 1.00–1.25%); realized NEER vol ~1.8%/yr;
calibration r² 0.96. Independent audit: 13/13 sense-checks pass.
