# Singapore Fundamentals Monitor + EM Rules Scanner — research & design (2026-08-23)

Status: **PROPOSAL — nothing built yet.** This is the research pass and module design for two new
deep-dive tabs. The live pricer is untouched by everything here.

Three threads, in the order they were raised:

1. **SG FUNDAMENTALS** — a country fundamentals monitor for Singapore (first instance of a per-country
   template), built around how MAS itself reads the economy, with an inflation model we own.
2. **High-frequency / online nowcast layer** — extend the official statistics with daily/weekly
   observable prices (COE, tariffs, fuel, rents, airfares, supermarket basket …).
3. **EM RULES** — a scanner that screens the EM universe against the backtested rules in
   Willer/Chandran/Lam, *Trading Fixed Income and FX in Emerging Markets* (already digested in the
   `em-macro-trader` skill).

Everything marked ✔ below was verified live today (Workspace desktop session up; MAS/SingStat hit
over HTTP). Everything marked ✘ could not be verified and is a known gap.

---

## 0. Architecture (same pattern as NEER / Risk Units / Carry Basket)

```
backend/
  sg_fundamentals_service.py   # sibling service; LSEG econ-indicator series + external fetchers + models
  em_rules_service.py          # sibling service; per-country RIC profiles + rule engine
  ext_data.py                  # NEW: tiny HTTP fetch layer (requests) with on-disk JSON cache + TTL
app.py                         # /api/fund/sg/* and /api/rules/* wired in lifespan next to neer/risk/carry
frontend/src/neer/
  SgFundamentals.jsx           # 4th top-level tab  [SGD NEER][RISK UNITS][CARRY BASKET][SG FUNDAMENTALS]
  EmRules.jsx                  # 5th top-level tab  [EM RULES]
```

- **LSEG first.** ~80% of the Singapore series exist as LSEG economic-indicator RICs (`aSG…`) and
  Reuters-poll RICs (`SG…=ECI`) and come through the existing `lseg_client.get_history` /
  `get_snapshot` machinery — same staleness/circuit-breaker handling as everything else.
- **Quota-safe by construction.** All of this is monthly/quarterly data: fetch once per day (plus a
  re-fetch on known release dates from the MAS/DOS advance calendar), cache on disk, never poll.
  Budget ≈ 60–80 get_history calls/day for the SG tab and ~1 batched snapshot per hour for the
  rules scanner → negligible against the 10k/day request cap.
- **External only where LSEG has a hole:** CPI sub-groups below division level (private road
  transport, accommodation, the 42 groups for trimmed-mean), URA rental index, SP electricity
  tariff, HDB rental transactions, SPF respondent data, MAS FCI/FSI anchors, COE bidding results
  (twice-monthly; LSEG only has the monthly PQP).

---

## 1. SG FUNDAMENTALS — what MAS actually tracks (and we will replicate)

Source of truth: Macroeconomic Review (now **quarterly**, same day as each MPS), Monetary Policy
Statements, Financial Stability Review, MAS Staff Papers 2025/1–2, BIS Paper 142 (MAS EPG), the
MR statistical appendix xlsx, and the FSR data-compilation xlsx. Full literature notes are in
§5.

### 1.1 Panels (MONITOR sub-tab)

| Theme | Metrics MAS charts / cites | Source (✔ verified) |
|---|---|---|
| **Inflation** | CPI-All Items y/y, **MAS Core** y/y, 3m/3m SAAR momentum, 25% trimmed mean & weighted median momentum (Staff Paper 2025/1), 6-way core contribution split (Food · Electricity & Gas · Retail & other goods · Essential svcs · Discretionary svcs · Travel svcs) + Accommodation + Private transport, consensus vs actual, MAS forecast range | LSEG `aSGCPI`, `aSGCPICOR`, divisions `aSGCPIF/H/TNC/HL…`; polls `SGCPIY=ECI`, `SGCPYY=ECI`; MAS JSON `inflation_rate_monthly`; 42-group table → SingStat |
| **Imported-cost channel** | Import price index (oil / non-oil / food re-weighted), regional PPI/export prices in local ccy, Brent (EPG assumption US$88/b 2026), FAO food, IMF fertiliser, GSCPI, S$NEER y/y (pass-through lead 2–14 months) | LSEG `aSGIMPP`, `aSGEXPP`, `aSGTOTRD/C`, `LCOc1`, `aSGDEOP` (NEER tool), FAO API |
| **Domestic-cost channel** | Unit labour cost (services ULC "adjusted for trend productivity" is MAS's central variable), nominal wage growth, **vacancy-to-unemployed ratio** (>2 = "unusually tight"), resident unemployment, retail & F&B sales volumes, output gap (EPG: **+0.7% of potential in 2026**) | LSEG `aSGULCT` (q), `aSGWAGESXR`, `aSGJOBVT`/`aSGCVACP`, `aSGCUNPQ/A`, `aSGRSLSM/CA`, `aSGIP/C` (HP-gap proxy) |
| **Administered / one-offs** | SP Group tariff (Q3-26: electricity **+17%**, gas +7%), GST steps (Jan-23, Jan-24), healthcare subsidy changes, S&CC rebates, transport fares, COE quota | Event calendar table (maintained by hand; drives model dummies); EMA/SP quarterly release |
| **Activity** | GDP y/y & q/q SAAR (MTI: **4.5–5.5% 2026**), IP, NODX, electronics, PMI (SIPMM new orders / input prices), composite leading index | LSEG `SGGDQY=ECI`, `aSGGDPXEUR/CA`, `aSGIP/C`, `aSGEXPDNO`, `SGPMI=ECI`, `aSGPMIMNOQ`, `aSGPMIINPP/A`, `aSGCLEAD` |
| **External** | Current account, official reserves (Jul-26 S$549bn), **FX intervention** (semi-annual net purchases; H1-25 US$14bn, H2-25 "–"), terms of trade, REER | LSEG `aSGFXRESO`, `aSGTOTRD/C`, `aSGIRELF/C`; MAS JSON `official_foreign_reserve_monthly`; MAS FX-ops page |
| **Monetary / financial conditions** | SORA & OIS (already in NEER tab), M2, bank loans by sector, **Domestic Liquidity Indicator** (MAS: f(ΔNEER, Δ3M SORA)), **Domestic FCI** (PCR on output gap), **Singapore FSI** (CISS-style, [0,1]) | LSEG `aSGM2`, `aSGLABUS`, `aSGCSMLOAN`, `aSGCRDNBCHL`; MR stat-appendix xlsx Table 14 (DLI); FSR-2025 data xlsx (FCI/FSI history → anchor our replicas) |
| **Policy** | MPS decision history (slope/width/centre since 2001), official forecast vintages, SPF medians + **SPF Table 4** (respondents' expected band moves at the next 3 meetings), reaction-function prior (MR Oct-18 Box A: slope ← core gap + output gap), MPS tone index (MR Apr-24 SF A) | MAS past-decisions page (server-rendered), SPF xlsx (respondent-level), MPS text (server-rendered, scrapeable) |

Calendar (verified): next CPI **24 Aug 2026** (consensus headline 2.31% vs 1.9 prior; core 2.2% vs
1.6 — the tariff step-up month), then 23 Sep / 23 Oct / 23 Nov; S$NEER weekly 7 Sep / 5 Oct;
SPF NLT 16 Sep; **MPS + MR NLT 14 Oct 2026**; FX-intervention H1-26 print ~end-Sep.

### 1.2 Inflation model (MODEL sub-tab) — phased, simplest first

MAS's own reduced-form core equation is published (BIS Paper 142, MAS EPG):

```
π_core,t = α + β·π_core,t−1 + γ·outputgap_t + λ·ImportPriceInfl_t + κ·ExcessWageGrowth_t + ε_t
```

and the CPI basket weights (2024 base, per 10,000) are: Food 2,042 (ex-F&B 651 · F&B serving 1,391),
Housing & utilities 2,938 (Accommodation **2,656** [imputed 2,138 · actual 294 · maintenance 224],
Utilities 282 [elec 179 · gas 19 · water 66]), Transport 1,307 (Private transport **906** [cars 459 ·
petrol 174 · other 161 · maint 57], land transport 262, airfares 129), Health 1,008, Recreation 595,
Education 579, Household durables 547, Misc 438, Info & comm 381, Clothing 165.
MAS Core = headline minus Accommodation minus Private transport = **64.4%** of the basket.

**M1 — bottom-up component nowcast (build first).** Forecast each block m/m SA with its own driver,
aggregate with effective Laspeyres weights, roll to y/y. Blocks and drivers (lags from MAS boxes):

| Block | Driver(s) | Lag structure (MAS) |
|---|---|---|
| Electricity & gas | SP tariff step (known ~2 wks before quarter; energy component = avg gas price over first 2.5 months of prior quarter) | deterministic, one quarter ahead |
| Private transport | COE Cat A/B premium (0–2m), pump prices (0m), VES/road-tax dummies | |
| Accommodation | URA private rental index + HDB rental growth, distributed lag 4–8 quarters; S&CC rebate calendar | "lagged pass-through of rents over the past year" |
| Food ex-F&B | DOS food import-price index, ULC | ERPT to food IPI 0.63 LR; IPI→CPI half in 4q (MR Apr-17 Box B) |
| F&B serving services | ULC, F&B volumes, URA retail rents | |
| Retail & other goods | non-oil IPI, NEER, GST dummies | goods respond ~2m before services; effects 14–20m (MR Oct-24 Box B) |
| Services (essential/discretionary/travel) | ULC adj. for trend productivity, jet fuel → airfares, subsidy/insurance/telco dummies | |

**M2 — reduced-form core Phillips curve (monthly version of BIS-142).** Output gap = HP/band-pass on
IP + retail/F&B volumes + v/u ratio; excess wages = residual of a wage Phillips curve; dummies for
GST/tariff/subsidy months; optional first stage `Δipi = a + b·Δneer + c·Δfpi`. Gives the
"momentum / demand / imported / wages" decomposition MAS shows in Graph 4 of BIS-142.

**M3 — small BVAR / conditional forecast (later).** Core SA, headline, IPI oil/non-oil, NEER, Brent,
IP, retail, COE, tariff, rents; conditional on known paths (tariff, COE quota, Brent futures).

Evaluation: pseudo-out-of-sample from 2015, compare RMSE vs (a) naive y/y carry-forward, (b) the
Reuters consensus (`FCAST_MEAN` on `SGCPIY=ECI`/`SGCPYY=ECI`). The UI shows next-print nowcast vs
consensus vs MAS range, plus the contribution waterfall. **Target**: beat naive at 1–3m and be
competitive with consensus on the next print.

Known pitfalls (all handled as dummies/flags): 2024 rebase + S-COICOP group boundary changes; GST
steps Jan-23/Jan-24; COE quota cycle; base effects (model m/m SA, derive y/y); MAS Core index not on
data.gov.sg (use MAS JSON endpoint or LSEG `aSGCPICOR`).

### 1.3 Policy sub-tab
- Band-decision timeline (2001→) with slope/width/centre chips, overlaid on the NEER-tool band chart.
- Reaction-function prior: `Δslope ∝ (core − ~2%) + outputgap` (MR Oct-18 Box A; MR Oct-21 SF A
  estimate +1pp expected inflation → +1.7% NEER, +1pp gap → +0.9%). Shows "what the rule says" vs
  SPF Table-4 expectations for the next meeting.
- MPS tone score (simple hawkish/dovish lexicon over the server-rendered statement text; MAS's own
  MR Apr-24 SF A is the template).

---

## 2. High-frequency / online nowcast layer (NOWCAST sub-tab)

Goal: see inflation forming *before* the 23rd-of-month print. Two tiers.

**Tier A — structured, low-risk feeds (build first):**

| Signal | Feeds into | Frequency | Source |
|---|---|---|---|
| Brent / gas over the tariff-setting window → next-quarter electricity tariff nowcast | Electricity & gas block | daily | LSEG `LCOc1`, TTF/JKM RICs; SP Group tariff xlsx (✔) |
| COE bidding results (Cat A/B/E premiums) | Private transport | 2×/month | data.gov.sg `d_69b3380ad7e51aff3a7dcc84eba52b8a` (✔ same-day) |
| Pump prices (95/98/diesel) | Private transport | weekly | Singapore petrol-price trackers (public pages) ✘ not yet verified |
| Jet fuel (Singapore kerosene) | Travel services / airfares | daily | LSEG jet kero RIC (to confirm) |
| HDB rental transactions + median rents; URA rental index | Accommodation (lead) | monthly / q | data.gov.sg HDB rental `d_c9f57…` (✔ to Jul-26); SingStat `M212311` (✔) |
| FAO food price index, rice/palm-oil/veg wholesale | Food | monthly/daily | FAO CSV (✔ Jul-26 131.1); LSEG commodity RICs; SFA wholesale prices ✘ |
| S$NEER live replica (already built) | Imported goods | live | NEER tool |

**Tier B — online scraped price basket (experimental):** a PriceStats-style daily index over a fixed
basket (supermarket online store for food/retail items; an airfare probe on a few fixed routes;
hawker/F&B menu sampling is not feasible). Honest caveats: ToS/anti-bot risk, fragility (site
changes), and the mapping to CPI items is rough — treat it as a *direction/momentum* indicator for
the Food and Retail blocks, not a level estimate. I'd start with one supermarket basket (~100 SKUs,
mapped to CPI classes) and evaluate its correlation with the food/retail CPI m/m before adding more.

---

## 3. EM RULES — Willer/Chandran/Lam rules scanner

Universe v1: the 13 countries with full verified data (TH BR MX ZA TR IN ID PL HU CL CO KR MY);
extensible to the pricer's 33 as RICs are verified. One batched snapshot (~150 RICs) per hour +
daily history for the cycle rules.

Each rule renders as a per-country state chip with the condition, the current reading, and "since"
date. This is a **screener** (which countries meet which conditions today), not a backtest — the book
supplies the backtested evidence; a backtest module can come later.

| # | Rule (book) | Condition we compute | Data |
|---|---|---|---|
| R1 | Rate-cycle turn: "receive around the last hike until the last cut is close" | 1Y swap − policy rate crosses below 0 (receive signal) / above 0 ~20td before first hike (pay) | 1Y IRS/OIS, policy poll |
| R2 | EM CBs stop hiking the same month inflation peaks; at first cut inflation still ~130bp above band | Inflation-peaked flag (CPI y/y below its 3m max for 2+ months) × policy-rate trajectory | CPI poll/series |
| R3 | Real-rate ranking: long top-3 / short bottom-3 real yields (deflate by target midpoint) | policy − target midpoint; also policy − CPI y/y | policy, CPI, target table |
| R4 | Term premium >1σ (3m rolling) → receive 5Y | z-score of (5Y − policy) over rolling 3m | 5Y swap |
| R5 | 2s10s steepeners work months before the first cut; flatteners into first hike | curve slope vs R1 phase | 2Y/10Y swaps |
| R6 | Risk overlay: max 2y z-score across EMFX IV, G10 IV, US rates IV, S&P IV, oil IV >2 → cut | z-scores of VIX, MOVE, OVX, CVIX, EM FX 1M ATM vols | LSEG vol RICs |
| R7 | Vol-adjusted carry (top-4 by carry/vol) | already computed in Carry Basket → reuse | carry service |
| R8 | 1M momentum; breadth (up vs down days) | 21d return; 21d up-day count | spot |
| R9 | UST >100bp sell-off in 3m → EMFX negative | 63d change in US 10Y | `US10YT=RR` |
| R10 | 12M CNH fwd >5% weaker than spot → extended shorts | CNH 12M outright / spot | pricer RICs |
| R11 | Emergency-hike success precondition: >30 daily-σ moves in 100d AND REER negative | count of |ret|>σ in 100d; REER vs 10y mean | spot, REER series |
| R12 | Event playbooks: elections (fade pessimism 2 wks before), IMF (+25d FX / +150d credit), interventions (BR >1.5%/5d, MX ~1%/15d) | event-date table (manual) + computed underperformance vs EMFX index | spot, event table |
| R13 | Breakevens: buy <target midpoint, sell >CPI+1.5–2.5% | where linkers exist (BR MX CL ZA …) — phase 2 | linker RICs (unverified) |

### 3.1 Verified RIC profile (the skill's `config.py` guesses were mostly wrong — these are live)

Fields: swaps `BID/ASK`; bonds `MID_YLD_1`; polls `ECON_ACT / ECON_PRIOR / FCAST_MEAN / VALUE_DT1`.

| CC | Policy rate | CPI y/y | Core y/y | 1Y/2Y/5Y/10Y swap (✔ today) | 10Y bond | CDS |
|---|---|---|---|---|---|---|
| TH | `THCBIR=ECI` | `THCPI=ECI` | `THCPIX=ECI` | `THB{t}OIS=` THOR OIS (1.05/1.27/1.63/2.06) | `TH10YT=RR` | `THGV5YUSAC=R` |
| BR | `BRCBMP=ECI` | `BRCPIY=ECI` | IPCA-15 `BRIPCY=ECI` | `BRPRE{t}=BVMF` (13.81/14.04/14.44/14.50) | `BR10YT=RR` | `BRGV5YUSAC=R` |
| MX | `MXCBIR=ECI` | `MXCPIA=ECI` | `MXCCPI=ECI` | `MXNIRS{t}=RR` (6.95/7.33/8.00/8.51) | `MX10YT=RR` | `MXGV5YUSAC=R` |
| ZA | `ZAREPO=ECI` | `ZACPIY=ECI` | `ZACPYY=ECI` | `ZARQB3ZB{t}=` (7.29/7.35/7.59/8.18) | `ZA10YT=RR` | `ZAGV5YUSAC=R` |
| TR | `TRINT=ECI` | `TRCPIY=ECI` | `TRCPCY=ECI` | `TRY{t}OIS=` TLREF (36.9/36.4/34.1/31.1) | `TR10YT=RR` | `TRGV5YUSAC=R` |
| IN | `INREPO=ECI` | `INCPIY=ECI` | – | `INRSMONMI{t}=` MIBOR OIS (1Y → `INR1YOIS=ICPM` 5.88; 6.15/6.46/6.64) | `IN10YT=RR` | `INGV5YUSAC=R` |
| ID | `IDCBRR=ECI` | `IDCPI=ECI` | `IDCPXY=ECI` | `IDRQM3JI{t}=INJA` (5.45/5.70/6.05/6.35) | `ID10YT=RR` | `IDGV5YUSAC=R` |
| PL | `PLINTR=ECI` | `PLCPIY=ECI` (flash `PLCFY=ECI`) | `PLNINF=ECI` | `PLNAB6W{t}=` (4.00/4.19/4.46/4.87) | `PL10YT=RR` | `PLGV5YUSAC=R` |
| HU | `HUINT=ECI` | `HUCPIY=ECI` | `HUCPIC=ECI` | `HUFAB6B{t}=` (5.40/5.30/5.16/5.10) | `HU10YT=RR` | `HUGV5YUSAC=R` |
| CL | `CLINTR=ECI` | `aCLCCPIYF` | `aCLCCORYF` | `CLP{t}OIS=` cámara (4.76/4.89/5.25/5.63) | `CL10YT=RR` | `CLGV5YUSAC=R` |
| CO | `COCBIR=ECI` | `COCPIY=ECI` | – | `COP{t}OIS=TRNY` IBR (12.05/11.18/10.43/10.36) | `CO10YT=RR` | `COGV5YUSAC=R` |
| KR | `KROCRT=ECI` | `KRCPIY=ECI` | – | `KRQMCD{t}=` CD IRS (3.46/3.75/4.00/4.14) | `KR10YT=RR` | `KRGV5YUSAC=R` |
| MY | `MYINTR=ECI` | `MYCPI=ECI` | – | `MYNDIRS{t}=` NDS (3.55/3.62/3.75/3.93); onshore `MYRQB3KL{t}=MY` | `MY10YT=RR` | `MYGV5YUSAC=R` |

Notes: THB fixed-float `THBQM3B10Y=` prints a stale 1.30 — use THOR OIS. `XX2YT=RR` exists for
TH/BR/IN/PL/KR only. Policy-rate *history* for R1/R2 via the `aXXPRATE`-style monthly series
(e.g. `aTHPRATER`, `aMYPRATE`) — to be confirmed per country when building.

---

## 4. Build order & decisions

| Phase | Deliverable | Effort |
|---|---|---|
| P1 | `ext_data.py` + `sg_fundamentals_service.py` data layer (LSEG series + MAS JSON + SingStat) with daily cache; **SG FUNDAMENTALS › MONITOR** tab (all §1.1 panels, release calendar, consensus-vs-actual) | 1–2 sessions |
| P2 | **MODEL** sub-tab: M1 bottom-up nowcast + M2 Phillips curve, backtest vs consensus, contribution waterfall; POLICY sub-tab | 2 sessions |
| P3 | **EM RULES** tab: `em_rules_service.py` with the verified profiles, R1–R12 screener matrix + country drill-down | 1–2 sessions |
| P4 | NOWCAST Tier A feeds; Tier B scraped basket as an experiment behind a flag | 1 session + ongoing |

Decisions I've taken (push back if wrong):
- SG Fundamentals is a **separate top-level tab**, country-parameterised from day one (config dict
  per country: RIC map, CPI weights, event calendar, policy framework) so the next country is a
  config file, not a rewrite.
- LSEG is the primary feed; MAS/SingStat/data.gov.sg fill gaps and act as validators (same
  philosophy as NEER: official series = anchor, not live input).
- The rules tab is a screener first; backtesting against the book's claims is a later, separate
  piece (and needs long histories that may hit the history quota).

Open questions for you:
1. Rules universe — the verified 13, or push to all 33 pricer currencies now (adds ~2 sessions of
   RIC verification for the frontier names)?
2. Inflation target midpoints per country for R3/R13 — use the skill's table or yours?
3. Tier B scraping appetite (it's the only part with ToS/fragility risk).

---

## 5. Research notes (for reference)

### 5.1 Most useful MAS/official sources
- **BIS Papers 142, "Recent inflation dynamics in Singapore" (MAS EPG)** — the published form of
  MAS's core Phillips curve; imported inflation dominated 2022; wage pass-through "relatively small".
- **MAS Staff Paper 2025/1 (Roger & Xiong), "Measuring Core Inflation…"** — trimmed mean / weighted
  median / volatility-adjusted core beat MAS Core on Granger-causing headline; MAS now charts T25.
- **MR Oct-2024 Box B, "Exchange Rate Pass-Through…"** — 1pp NEER shock → −2pp headline / −1pp core
  over 12m (upper bound), goods lead services by ~2m, dampened when labour market tight.
- **MR Apr-2017 Box B, food price pass-through** — ECM elasticities used in the Food block.
- **DOS CPI rebasing paper (2024 base)** — weights above; hedonic used cars; rental-equivalence rents.
- **FSR 2024 SF2 "Expanding the Toolkit for Macroprudential Surveillance"** — FSI/FCI/FVI
  definitions; **FSR 2025 data-compilation xlsx** has the FCI/FSI series.
- **MR Oct-2018 Box A** (monetary-policy rule), **MR Oct-2020 Box A** (UIP S$ vs US$),
  **MR Apr-2023 Box A** (v/u ratio & Beveridge curve), **MR Oct-2019 Box B** (wage Phillips curve),
  **MR Apr-2024 SF A** (MPS text analysis), **MAS SP 2025/2** (Asian capital flows & global cycle).
- **MAS SPF**: respondent-level xlsx per quarter (`…/spf/2026/jun26q2.xlsx`, `survey-1999-2024.zip`);
  Jun-26 medians: CPI 2.3% / core 2.0% (2026), USD/SGD 1.258 end-26, SORA avg 1.20%.
- Official 2026: MAS Core & CPI-All Items **1.5–2.5%** (raised Apr-26; held Jul-26); output gap
  **+0.7%**; MTI GDP **4.5–5.5%** (11 Aug). MPS: 29 Jan (hold) · 14 Apr (slope ↑ slightly) ·
  27 Jul (slope ↑ very slightly) · **NLT 14 Oct**.

### 5.2 External endpoints — verified 2026-08-23

**MAS (www.mas.gov.sg) chart JSON — ✔ no auth**, `GET https://www.mas.gov.sg/api/v1/MAS/chart/rev/<view>`
(or `/api/v1/MAS/chart/<view>` for MSB tables). Shape `{"name","elements":[…]}`, newest first.

| View | Content | Latest |
|---|---|---|
| `rev/sneer` | weekly S$NEER, 1999-01-08=100, published monthly | 2026-07-31 141.63 |
| `rev/inflation_rate_monthly` (`_quarterly`, `_yearly`) | MAS Core index (2024=100) + y/y, 1990→ | Jun-26 102.172 / 1.6 |
| `rev/swappoint` | daily USD/SGD 1M/3M/6M swap points, 2006→ | 2026-07-31 −27.83/−82.75/−167.63 |
| `rev/official_foreign_reserve_monthly`, `iv_7_official_foreign_reserves_monthly` | OFR | Jul-26 S$549.3bn |
| `table_i_1_money_supply_sgd`, `table_i_5a_commercial_banks_loans_and_advances_to_residents_by_industry`, `table_i_2a_monetary_survey_sgd`, `i_2c_monetary_authority_assets_and_liabilities_monthly`, `table_iii_3a_…dep_rate…` | MSB tables (last 60m / full) | Jun-26 |

No SORA / FX / SGS / headline-CPI / forecast views. **The old MAS datastore API
(`eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=…`) is dead** — returns an HTML
failover page. Its replacement is the MAS API portal (`eservices.mas.gov.sg/apimg-portal`, 108
products incl. daily SORA `10484`, daily FX `10485`, MSB tables) which needs a `KeyId` header from a
free subscription (Corppass **or "Continue as Guest"**, key valid 1 year, no stated call limits).
Not needed for v1 — SORA/FX come from LSEG — but worth registering for as the official fallback.
Legacy ASP.NET forms (`eservices.mas.gov.sg/Statistics/dir/DomesticInterestRates.aspx`,
`…/fdanet/BenchmarkPricesAndYields.aspx`, `…/msb/ExchangeRates.aspx`) still export CSV via
VIEWSTATE POST (SORA 20-Aug 1.3892%; SGS 2y 1.68 / 10y 2.36 on 21-Aug) — brittle, fallback only.

**SingStat Table Builder — ✔ no auth**, `GET https://tablebuilder.singstat.gov.sg/api/table/tabledata/{id}`
(100 calls/min/IP; `limit`/`offset` count *cells*, max 5000 → use `seriesNoORrowNo=` and
`timeFilter=` or `sortBy=key desc`). 2019-base IDs are gone (404); 2024-base IDs:

| Series | ID | Latest |
|---|---|---|
| **CPI 2024=100, 207 series incl. all groups** (1.03.1 Accommodation, 1.06.1 Private Transport, 1.11 F&B serving…) | `M213751` (y/y `M213781`, m/m `M213771`, SA `M213752`/`M213792`) | Jun-26 All Items 102.858; y/y 1.9 |
| **MAS Core + Services / Retail & other goods / Electricity & gas** | `M213891` | core 102.172, y/y 1.6; E&G y/y −2.9 |
| Real GDP y/y by industry / q/q SAAR | `M015631` / `M015792` | Q2-26 5.9% / 5.7% |
| Unemployment (NSA/SA, quarterly) | `M182341` / `M182342` | Q2-26 2.0 SA |
| Retail sales (2025=100; current NSA/SA, volume NSA/SA) | `M602121/2`, `M602201/2` | Jun-26 |
| IP (2025=100; NSA/SA/y/y/cluster) | `M355351/2`, `M355411`, `M355381` | Jun-26 y/y 7.2% |
| NODX by market / product; trade SA | `M451301` / `M450981`; `M451002` | Jul-26 19.38bn |
| Import price index (2023=100, oil/non-oil) · DSPI · MPPI | `M213241` · `M213381` · `M213431` | Jun-26 103.463 |
| Unit labour cost (NSA/SA, q) | `M183741` / `M183742` | Q2-26 112.9 |
| URA private rental index (all/landed/non-landed; by locality) | `M212311` / `M212321` | Q2-26 162.5 |
| URA price index · HDB resale price index | `M212261` · `M212161` | Q2-26 219.4 · 202.8 |
| Electricity tariff (monthly, lags a quarter) | `M890991` | Jun-26 27.27¢ |
| COE quota premiums per exercise (LTA) | `M651121` | Jul-26 Cat A 129k/126k |

**data.gov.sg — ✔ no auth** (rate-limited: ≤3 calls/10s unkeyed; free key raises it):
`GET https://data.gov.sg/api/action/datastore_search?resource_id={id}&sort=_id desc` —
**COE bidding results `d_69b3380ad7e51aff3a7dcc84eba52b8a`** (updated same day as each exercise;
Aug-2: A 128,501 / B 131,001 / E 135,000), HDB rental transactions `d_c9f57187485a850908655db0e8cfe651`
(monthly, to Jul-26), HDB median rent `d_23000a00c52996c55106084ed0339566`, URA rental index
`d_8e4c50283fb7052a391dfb746a05c853`, electricity tariff `d_61eac3cdb086814af485dcc682b75ae9`.

**Other**: SP Group tariff history xlsx
`https://www.spgroup.com.sg/dam/spgroup/pdf/resources/billing/Historical-Electricity-Tariff.xlsx`
(**Q3-26 31.91¢ ex-GST, +17% q/q**, energy component 25.50); FAO Food Price Index CSV
(`fao.org/…/food_price_indices_data.csv`, Jul-26 131.1, next 4 Sep); EIA Brent API (free key);
SInDEx (SMU) quarterly inflation expectations — PDF/press-release only (Jun-26: 1y-ahead headline
3.4%, core 3.4%); SPF respondent-level xlsx `…/spf/2026/jun26q2.xlsx` + `survey-1999-2024.zip`.
MPS pages and the past-decisions table are server-rendered (scrapeable); no RSS.

### 5.3 Gaps (✘)
- MAS DLI weights, output-gap method, NEER basket/band parameters — undisclosed (replicate/anchor).
- FVI series not published (heatmaps only). "Persistence-weighted core" method not published.
- SA 42-group CPI series may not be public (trimmed mean may have to be built on NSA + own SA).
- Quantified rent → accommodation-CPI lag not published by MAS (estimate it ourselves).
- Linker RICs for R13 unverified. Policy-rate history RICs per country to confirm during P3.
