"""
EM Rules — Willer/Chandran/Lam (*Trading Fixed Income and FX in Emerging
Markets*) rules screener over the pricer's EM universe (+ BR).

This is a SCREENER, not a backtest: the book supplies the backtested evidence;
each rule renders as a per-country state with the current reading. See
SG_FUNDAMENTALS_PLAN.md §3 for the rule table and the verified RIC map
(all RICs below were live-verified 2026-08-23/24).

Rules v1:
  R1  rate-cycle turn:  1Y swap − policy (receive when < 0; "since" from the
      1Y swap's daily history crossing the current policy level — approx)
  R2  inflation peaked (last hike comes the month inflation peaks): CPI y/y
      below its 6m max for 2+ months and falling
  R3  real policy rate = policy − CPI y/y, and policy − target midpoint (rank)
  R4  term premium: z-score of (5Y − policy) over rolling 3m > 1 → receive 5Y
  R5  curve: 2s10s (1s10s where no 2Y) level + 3m change, read vs R1 phase
  R6  global risk overlay: max 2y z-score across VIX / MOVE / OVX > 2 → cut
  R8  1M FX momentum + breadth (up-days of the EM ccy vs USD in 21d)
  R9  UST >100bp in 3m → EMFX negative (global)
  R10 CNH 12M forward >5% weaker than spot → extended shorts (global)
  R11 emergency-hike preconditions: >30 |ret|>1σ days in 100d AND REER cheap
  R12 event playbooks — static event table (structure only in v1)

Data budget: one batched snapshot + ~25 chunked get_history calls per build,
cached 12h. Carry/vol (R7) is read by the FRONTEND from /api/carry/rank.
"""
from __future__ import annotations

import datetime as dt
import logging
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np

log = logging.getLogger("em_rules")

_TTL = 12 * 3600
_TENORS = ["1Y", "2Y", "5Y", "10Y"]

# ─────────────────────────── universe config ───────────────────────────
# swap: RIC pattern with {t}. hist="daily"/"monthly" for the policy series.
# target: official CB inflation target midpoint (band, note where relevant).
COUNTRIES: Dict[str, Dict[str, Any]] = {
    "BR": {"name": "Brazil",       "ccy": "BRL", "spot": "BRL=",  "policy": "BRCBMP=ECI", "cpi": "BRCPIY=ECI", "core": "BRIPCY=ECI", "swap": "BRPRE{t}=BVMF", "cds": "BRGV5YUSAC=R", "target": (3.0, "±1.5"), "region": "Latam"},
    "MX": {"name": "Mexico",       "ccy": "MXN", "spot": "MXN=",  "policy": "MXCBIR=ECI", "cpi": "MXCPIA=ECI", "core": "MXCCPI=ECI", "swap": "MXNIRS{t}=RR", "cds": "MXGV5YUSAC=R", "target": (3.0, "±1"), "region": "Latam"},
    "CL": {"name": "Chile",        "ccy": "CLP", "spot": "CLP=",  "policy": "CLINTR=ECI", "cpi": "aCLCCPIYF", "cpi_hist": "aCLCCPIYF", "swap": "CLP{t}OIS=", "cds": "CLGV5YUSAC=R", "target": (3.0, "±1"), "region": "Latam"},
    "CO": {"name": "Colombia",     "ccy": "COP", "spot": "COP=",  "policy": "COCBIR=ECI", "cpi": "COCPIY=ECI", "swap": "COP{t}OIS=TRNY", "cds": "COGV5YUSAC=R", "target": (3.0, "±1"), "region": "Latam"},
    "CZ": {"name": "Czechia",      "ccy": "CZK", "spot": "CZK=",  "policy": "CZCBIR=ECI", "cpi": "CZCPIY=ECI", "swap": "CZKAM6PR{t}=", "cds": "CZGV5YUSAC=R", "target": (2.0, "±1"), "region": "CEEMEA"},
    "PL": {"name": "Poland",       "ccy": "PLN", "spot": "PLN=",  "policy": "PLINTR=ECI", "cpi": "PLCPIY=ECI", "core": "PLNINF=ECI", "swap": "PLNAB6W{t}=", "cds": "PLGV5YUSAC=R", "target": (2.5, "±1"), "region": "CEEMEA"},
    "HU": {"name": "Hungary",      "ccy": "HUF", "spot": "HUF=",  "policy": "HUINT=ECI",  "cpi": "HUCPIY=ECI", "core": "HUCPIC=ECI", "swap": "HUFAB6B{t}=", "cds": "HUGV5YUSAC=R", "target": (3.0, "±1"), "region": "CEEMEA"},
    "RO": {"name": "Romania",      "ccy": "RON", "spot": "RON=",  "policy": "ROINTR=ECI", "cpi": "ROCPI=ECI",  "swap": "RONAM3R{t}=", "cds": "ROGV5YUSAC=R", "target": (2.5, "±1"), "region": "CEEMEA"},
    "ZA": {"name": "South Africa", "ccy": "ZAR", "spot": "ZAR=",  "policy": "ZAREPO=ECI", "cpi": "ZACPIY=ECI", "core": "ZACPYY=ECI", "swap": "ZARQB3ZB{t}=", "cds": "ZAGV5YUSAC=R", "target": (4.5, "3–6; SARB de-facto 3% objective since 2025"), "region": "CEEMEA"},
    "TR": {"name": "Türkiye",      "ccy": "TRY", "spot": "TRY=",  "policy": "TRINT=ECI",  "cpi": "TRCPIY=ECI", "core": "TRCPCY=ECI", "swap": "TRY{t}OIS=", "cds": "TRGV5YUSAC=R", "target": (5.0, "±2"), "region": "CEEMEA"},
    "IL": {"name": "Israel",       "ccy": "ILS", "spot": "ILS=",  "policy": "ILINR=ECI",  "cpi": "ILCPIY=ECI", "swap": "ILSAM3T{t}=", "cds": "ILGV5YUSAC=R", "target": (2.0, "1–3"), "region": "CEEMEA"},
    "RU": {"name": "Russia",       "ccy": "RUB", "spot": "RUB=",  "policy": "aRUPRATE", "policy_hist_iv": "monthly", "cpi": "RUCPIY=ECI", "swap": "RUBAM3MO{t}=", "target": (4.0, "sanctioned — data unreliable"), "region": "CEEMEA"},
    "KZ": {"name": "Kazakhstan",   "ccy": "KZT", "spot": "KZT=",  "policy": "KZCBIR=ECI", "cpi": "KZCPIY=ECI", "swap": "KZTTNI{t}OIS=OGRV", "cds": "KZGV5YUSAC=R", "target": (5.0, "NBK medium-term"), "region": "CEEMEA"},
    "IN": {"name": "India",        "ccy": "INR", "spot": "INR=",  "policy": "INREPO=ECI", "cpi": "INCPIY=ECI", "swap": {"1Y": "INR1YOIS=ICPM", "2Y": "INRSMONMI2Y=", "5Y": "INRSMONMI5Y=", "10Y": "INRSMONMI10Y="}, "cds": "INGV5YUSAC=R", "target": (4.0, "±2"), "region": "Asia"},
    "ID": {"name": "Indonesia",    "ccy": "IDR", "spot": "IDR=",  "policy": "IDCBRR=ECI", "cpi": "IDCPI=ECI",  "core": "IDCPXY=ECI", "swap": "IDRQM3JI{t}=INJA", "cds": "IDGV5YUSAC=R", "target": (2.5, "±1"), "region": "Asia"},
    "KR": {"name": "South Korea",  "ccy": "KRW", "spot": "KRW=",  "policy": "KROCRT=ECI", "cpi": "KRCPIY=ECI", "swap": "KRQMCD{t}=", "cds": "KRGV5YUSAC=R", "target": (2.0, "point"), "region": "Asia"},
    "TH": {"name": "Thailand",     "ccy": "THB", "spot": "THB=",  "policy": "THCBIR=ECI", "cpi": "THCPI=ECI",  "core": "THCPIX=ECI", "swap": "THB{t}OIS=", "cds": "THGV5YUSAC=R", "target": (2.0, "1–3"), "region": "Asia"},
    "MY": {"name": "Malaysia",     "ccy": "MYR", "spot": "MYR=",  "policy": "MYINTR=ECI", "cpi": "MYCPI=ECI",  "swap": "MYNDIRS{t}=", "cds": "MYGV5YUSAC=R", "target": (None, "no formal target"), "region": "Asia"},
    "PH": {"name": "Philippines",  "ccy": "PHP", "spot": "PHP=",  "policy": "PHCBIR=ECI", "cpi": "PHCPI=ECI",  "core": "PHCPXY=ECI", "swap": "PHPPO{t}OIS=TPPH", "cds": "PHGV5YUSAC=R", "target": (3.0, "±1"), "region": "Asia"},
    "CN": {"name": "China",        "ccy": "CNH", "spot": "CNH=",  "policy": "CNLPRO=ECI", "cpi": "CNCPI=ECI",  "swap": "CNYQM7R{t}=", "cds": "CNGV5YUSAC=R", "target": (3.0, "~ceiling, not a hard target"), "region": "Asia"},
    "TW": {"name": "Taiwan",       "ccy": "TWD", "spot": "TWD=",  "policy": "TWINTR=ECI", "cpi": "TWCPIY=ECI", "swap": "TWNDQM3TO{t}=", "target": (None, "no formal target (~2 implicit)"), "region": "Asia"},
    "SG": {"name": "Singapore",    "ccy": "SGD", "spot": "SGD=",  "policy": None, "cpi": "SGCPIY=ECI", "core": "SGCPYY=ECI", "swap": "SGDSRA{t}OIS=", "target": (2.0, "MAS ~2% core medium-term objective; NEER-based policy"), "region": "Asia", "note": "exchange-rate policy — rate rules read via SORA OIS"},
    "HK": {"name": "Hong Kong",    "ccy": "HKD", "spot": "HKD=",  "policy": "aHKDWBR", "policy_hist_iv": "daily", "cpi": "HKCPIY=ECI", "swap": "HKDQM3H{t}=", "cds": "HKGV5YUSAC=R", "target": (None, "currency board"), "region": "Asia"},
    "AE": {"name": "UAE",          "ccy": "AED", "spot": "AED=",  "policy": "AEINTR=ECI", "cpi": "AECPIY=ECI", "swap": "AEDAM3A{t}=", "target": (None, "USD peg"), "region": "GCC"},
    "SA": {"name": "Saudi Arabia", "ccy": "SAR", "spot": "SAR=",  "policy": "aSAPRATE1", "policy_hist_iv": "daily", "cpi": "SACPIY=ECI", "swap": "SARAM3L{t}=", "cds": "SAGV5YUSAC=R", "target": (None, "USD peg"), "region": "GCC"},
    "QA": {"name": "Qatar",        "ccy": "QAR", "spot": "QAR=",  "policy": "aQALRATE", "policy_hist_iv": "daily", "cpi": "QACPIY=ECI", "swap": "QARAM3Q{t}=GMGM", "cds": "QAGV5YUSAC=R", "target": (None, "USD peg"), "region": "GCC"},
    "EG": {"name": "Egypt",        "ccy": "EGP", "spot": "EGP=",  "policy": "EGINTR=ECI", "cpi": "EGCPY=ECI", "core": "EGCCPI=ECI", "swap": None, "cds": "EGGV5YUSAC=R", "target": (7.0, "±2 (Q4-26 objective)"), "region": "Africa"},
    "NG": {"name": "Nigeria",      "ccy": "NGN", "spot": "NGN=",  "policy": "NGCBIR=ECI", "cpi": "NGCPIY=ECI", "swap": None, "cds": "NGGV5YUSAC=R", "target": (None, "no formal target"), "region": "Africa"},
    "MA": {"name": "Morocco",      "ccy": "MAD", "spot": "MAD=",  "policy": "aMAPRATE", "policy_hist_iv": "monthly", "cpi": "aMACCPIYF", "cpi_hist": "aMACCPIYF", "swap": None, "cds": "MAGV5YUSAC=R", "target": (None, "no formal target"), "region": "Africa"},
    "TN": {"name": "Tunisia",      "ccy": "TND", "spot": "TND=",  "policy": "aTNPRATE", "policy_hist_iv": "monthly", "cpi": "aTNCCPIYF", "cpi_hist": "aTNCCPIYF", "swap": None, "target": (None, "no formal target"), "region": "Africa"},
    "MU": {"name": "Mauritius",    "ccy": "MUR", "spot": "MUR=",  "policy": "MUCBIR=ECI", "cpi": "MUCPIY=ECI", "swap": None, "target": (3.5, "2–5"), "region": "Africa"},
    "BW": {"name": "Botswana",     "ccy": "BWP", "spot": "BWP=",  "policy": "BWRATE=ECI", "cpi": "BWCPIY=ECI", "swap": None, "target": (4.5, "3–6"), "region": "Africa"},
    "UG": {"name": "Uganda",       "ccy": "UGX", "spot": "UGX=",  "policy": "UGCBIR=ECI", "cpi": "UGCPIY=ECI", "swap": None, "target": (5.0, "core, medium-term"), "region": "Africa"},
}
# CCYs whose USDXXX quote is inverted in the pricer sense (none here — all USD/XXX)
_GLOBAL = {"vix": ".VIX", "move": ".MOVE", "ovx": ".OVX", "us10y": "US10YT=RR",
           "cnhSpot": "CNH=", "cnh12mPts": "CNH1Y="}
_CNH_PIP = 10000.0

# R12 event table (date, cc, type) — maintained by hand; structure for v1
EVENTS: List[Dict[str, str]] = []


def _z(series: List[float], window: int) -> Optional[float]:
    xs = [x for x in series[-window:] if x is not None]
    if len(xs) < max(20, window // 4):
        return None
    sd = float(np.std(xs))
    return round((xs[-1] - float(np.mean(xs))) / sd, 2) if sd > 1e-9 else None


class EmRulesService:
    def __init__(self, lseg):
        self.lseg = lseg
        self._cache: Optional[Dict[str, Any]] = None
        self._cache_ts: float = 0.0
        self._lock = threading.Lock()

    # ── data pulls ──
    def _swap_ric(self, cfg: Dict[str, Any], t: str) -> Optional[str]:
        sw = cfg.get("swap")
        if sw is None:
            return None
        return sw.get(t) if isinstance(sw, dict) else sw.format(t=t)

    def _snapshot(self) -> Dict[str, Dict[str, Any]]:
        rics: List[str] = []
        for cfg in COUNTRIES.values():
            for k in ("policy", "cpi", "core", "cds"):
                r = cfg.get(k)
                if r and "=" in r:      # snapshot only quote-style RICs
                    rics.append(r)
            for t in _TENORS:
                r = self._swap_ric(cfg, t)
                if r:
                    rics.append(r)
        rics += [_GLOBAL["vix"], _GLOBAL["move"], _GLOBAL["ovx"], _GLOBAL["us10y"],
                 _GLOBAL["cnhSpot"], _GLOBAL["cnh12mPts"]]
        fields = ["ECON_ACT", "ECON_PRIOR", "FCAST_MEAN", "VALUE_DT1",
                  "BID", "ASK", "PRIMACT_1", "CF_LAST", "MID_YLD_1"]
        try:
            snap = self.lseg.get_snapshot(sorted(set(rics)), fields)
        except Exception as e:
            log.error("rules snapshot failed: %s", e)
            snap = {}
        return snap

    def _daily_hist(self, rics: List[str], fields: List[str], days: int = 420) -> Dict[str, List[dict]]:
        out: Dict[str, List[dict]] = {}
        start = (dt.date.today() - dt.timedelta(days=days)).isoformat()
        end = dt.date.today().isoformat()
        for i in range(0, len(rics), 8):
            chunk = rics[i:i + 8]
            try:
                h = self.lseg.get_history(chunk, fields=fields, interval="daily",
                                          start=start, end=end)
            except Exception as e:
                log.error("daily hist chunk failed: %s", e)
                h = {}
            if "default" in h and len(chunk) > 1:
                for ric in chunk:
                    out[ric] = [{"Date": r["Date"], "VALUE": r.get(ric)}
                                for r in h["default"] if r.get(ric) is not None]
            else:
                for ric in chunk:
                    out[ric] = h.get(ric) or h.get("default") or []
        return out

    def _monthly_hist(self, rics: List[str], years: int = 4) -> Dict[str, List[dict]]:
        out: Dict[str, List[dict]] = {}
        start = f"{dt.date.today().year - years}-01-01"
        end = dt.date.today().isoformat()
        for i in range(0, len(rics), 8):
            chunk = rics[i:i + 8]
            try:
                h = self.lseg.get_history(chunk, fields=["VALUE"], interval="monthly",
                                          start=start, end=end)
            except Exception as e:
                log.error("monthly hist chunk failed: %s", e)
                h = {}
            if "default" in h and len(chunk) > 1:
                for ric in chunk:
                    out[ric] = [{"Date": r["Date"], "VALUE": r.get(ric)}
                                for r in h["default"] if r.get(ric) is not None]
            else:
                for ric in chunk:
                    out[ric] = h.get(ric) or h.get("default") or []
        return out

    @staticmethod
    def _vals(recs: List[dict]) -> List[float]:
        return [float(r["VALUE"]) for r in recs or []
                if isinstance(r.get("VALUE"), (int, float))]

    @staticmethod
    def _num(snap_row: Dict[str, Any], *fields) -> Optional[float]:
        for f in fields:
            v = (snap_row or {}).get(f)
            if isinstance(v, (int, float)) and np.isfinite(v):
                return float(v)
            try:
                if v is not None:
                    import pandas as pd
                    if not pd.isna(v):
                        return float(v)
            except (TypeError, ValueError):
                continue
        return None

    # ── build ──
    def build(self, refresh: bool = False) -> Dict[str, Any]:
        with self._lock:
            if not refresh and self._cache and (time.time() - self._cache_ts) < _TTL:
                return self._cache
            t0 = time.time()
            snap = self._snapshot()

            # histories
            swap_hist_rics, spot_rics, cpi_hist_rics, policy_hist_rics = [], [], [], []
            for cc, cfg in COUNTRIES.items():
                for t in ("1Y", "2Y", "5Y", "10Y"):
                    r = self._swap_ric(cfg, t)
                    if r:
                        swap_hist_rics.append(r)
                spot_rics.append(cfg["spot"])
                cpi_hist_rics.append(cfg.get("cpi_hist") or cfg["cpi"])
                pr = cfg.get("policy")
                if pr and not pr.endswith("=ECI"):
                    policy_hist_rics.append(pr)
            dh = self._daily_hist(sorted(set(swap_hist_rics + spot_rics + ["LCOc1"])),
                                  fields=["BID", "ASK", "TRDPRC_1"])
            us10 = self._daily_hist([_GLOBAL["us10y"]], fields=["MID_YLD_1", "B_YLD_1"])
            mh = self._monthly_hist(sorted(set(cpi_hist_rics + policy_hist_rics)))

            def dvals(ric: str) -> List[float]:
                out = []
                for r in dh.get(ric, []):
                    v = r.get("VALUE")
                    if v is None:
                        for f in ("BID", "TRDPRC_1", "ASK"):
                            if isinstance(r.get(f), (int, float)):
                                v = r[f]
                                break
                    if isinstance(v, (int, float)):
                        out.append(float(v))
                return out

            # ── global rules ──
            us_vals = []
            for r in us10.get(_GLOBAL["us10y"], []):
                v = r.get("MID_YLD_1") or r.get("B_YLD_1") or r.get("VALUE")
                if isinstance(v, (int, float)):
                    us_vals.append(float(v))
            r9 = None
            if len(us_vals) > 70:
                r9 = round((us_vals[-1] - us_vals[-64]) * 100.0, 0)   # bp over ~3m
            # R6 via REALIZED-vol proxies — this Workspace has no index-history
            # entitlement (.VIX/.MOVE/.OVX history → UserNotPermission), so:
            #   emfx  = cross-sectional avg of per-ccy 20d realized vol (our spots)
            #   rates = 20d realized vol of daily US10Y bp changes
            #   oil   = 20d realized vol of Brent (LCOc1)
            # z over the fetched ~1.5y window (book uses 2y of IVs — labeled proxy).
            def _roll_sd(vals: List[float], scale: float = 1.0) -> List[float]:
                r = np.diff(np.log(vals)) if scale == 1.0 else np.diff(vals) * scale
                return [float(np.std(r[i - 20:i])) for i in range(20, len(r) + 1)]

            vol_z: Dict[str, Optional[float]] = {}
            per_ccy_sd = []
            for cfg in COUNTRIES.values():
                sp = dvals(cfg["spot"])
                if len(sp) > 60:
                    per_ccy_sd.append(_roll_sd(sp))
            if per_ccy_sd:
                n = min(len(x) for x in per_ccy_sd)
                emfx = [float(np.mean([x[-n + i] for x in per_ccy_sd])) for i in range(n)]
                vol_z["emfxRealized"] = _z(emfx, len(emfx))
            if len(us_vals) > 60:
                vol_z["usRatesRealized"] = _z(_roll_sd(us_vals, scale=100.0), 500)
            brent = dvals("LCOc1")
            if len(brent) > 60:
                vol_z["oilRealized"] = _z(_roll_sd(brent), 500)
            vix_live = self._num(snap.get(_GLOBAL["vix"]), "CF_LAST", "PRIMACT_1", "TRDPRC_1")
            vol_z = {k: v for k, v in vol_z.items() if v is not None}
            r6_max = max(vol_z.values()) if vol_z else None
            cnh_spot = self._num(snap.get(_GLOBAL["cnhSpot"]), "BID", "PRIMACT_1", "CF_LAST")
            cnh_pts = self._num(snap.get(_GLOBAL["cnh12mPts"]), "BID", "PRIMACT_1", "CF_LAST")
            r10 = None
            if cnh_spot and cnh_pts is not None:
                r10 = round(cnh_pts / _CNH_PIP / cnh_spot * 100.0, 2)   # % 12m depreciation priced

            # No-proxy rule: a missing input must read "no data", never default to
            # the benign state ("risk on"/"ok") — that renders an outage as an all-clear.
            global_block = {
                "r6": {"maxZ": r6_max, "z": vol_z, "vixLive": vix_live,
                       "state": ("no data" if r6_max is None
                                 else "CUT EXPOSURE" if r6_max > 2 else "risk on"),
                       "rule": "max z of EMFX/US-rates/oil REALIZED vol > 2 → cut "
                               "(realized proxy — IV history not entitled on this Workspace)"},
                "r9": {"ust3mBp": r9, "state": ("no data" if r9 is None
                                                else "EMFX NEGATIVE" if r9 > 100 else "ok"),
                       "rule": "UST 10Y +100bp in 3m is reliably EMFX-negative"},
                "r10": {"cnh12mPct": r10, "state": ("no data" if r10 is None
                                                    else "EXTENDED SHORTS" if r10 > 5 else "ok"),
                        "rule": "CNH 12M fwd >5% weaker than spot = extended positioning"},
            }

            # ── per-country ──
            rows = []
            for cc, cfg in COUNTRIES.items():
                srow: Dict[str, Any] = {"cc": cc, "name": cfg["name"], "ccy": cfg["ccy"],
                                        "region": cfg["region"], "note": cfg.get("note")}
                # policy level
                pr = cfg.get("policy")
                policy = None
                if pr and pr.endswith("=ECI"):
                    policy = self._num(snap.get(pr), "ECON_ACT", "ECON_PRIOR")
                elif pr:
                    pv = self._vals(mh.get(pr))
                    policy = pv[-1] if pv else None
                srow["policy"] = policy
                # CPI y/y (+ history for R2)
                cpi_now = self._num(snap.get(cfg["cpi"]), "ECON_ACT", "ECON_PRIOR") \
                    if cfg["cpi"].endswith("=ECI") else None
                cpi_series = self._vals(mh.get(cfg.get("cpi_hist") or cfg["cpi"]))
                if cpi_now is None and cpi_series:
                    cpi_now = cpi_series[-1]
                srow["cpiYoY"] = round(cpi_now, 2) if cpi_now is not None else None
                cpi_now = srow["cpiYoY"]
                srow["core"] = self._num(snap.get(cfg.get("core")), "ECON_ACT", "ECON_PRIOR") \
                    if cfg.get("core") else None
                # swaps
                curve = {t: self._num(snap.get(self._swap_ric(cfg, t) or ""), "BID", "PRIMACT_1", "CF_LAST")
                         for t in _TENORS}
                srow["swap"] = curve
                srow["cds"] = self._num(snap.get(cfg.get("cds")), "PRIMACT_1", "CF_LAST") \
                    if cfg.get("cds") else None

                # R1 — cycle turn
                y1, p = curve.get("1Y"), policy
                if y1 is not None and p is not None:
                    gap = round(y1 - p, 2)
                    state = "RECEIVE" if gap < -0.10 else "PAY" if gap > 0.25 else "neutral"
                    since = None
                    h1 = dvals(self._swap_ric(cfg, "1Y"))
                    if len(h1) > 10:
                        sign = gap < 0
                        k = len(h1) - 1
                        while k > 0 and ((h1[k] - p) < 0) == sign:
                            k -= 1
                        since = f"~{len(h1) - 1 - k}d"
                    srow["r1"] = {"gap1y": gap, "state": state, "since": since}
                else:
                    srow["r1"] = None
                # R2 — inflation peaked / rising / flat. "rising" (near the recent max
                # AND above the prior print) is the PAY-side state; flat-at-target is
                # NEITHER — the book's rule is a hiking-cycle turn-timer with no signal
                # in the steady state (pegs, long-since-disinflated countries).
                if len(cpi_series) >= 8:
                    recent = cpi_series[-7:]
                    mx = max(recent)
                    peaked = (recent[-1] < mx - 0.15) and (recent[-1] <= recent[-2] or recent[-2] <= recent[-3])
                    rising = (not peaked) and recent[-1] >= mx - 0.15 and recent[-1] > recent[-2]
                    srow["r2"] = {"peaked": bool(peaked), "rising": bool(rising),
                                  "latest": round(recent[-1], 2), "max6m": round(mx, 2)}
                else:
                    srow["r2"] = None
                # R3 — real rates
                tgt = cfg["target"][0]
                srow["r3"] = {
                    "real": round(p - cpi_now, 2) if p is not None and cpi_now is not None else None,
                    "realVsTarget": round(p - tgt, 2) if p is not None and tgt is not None else None,
                    "targetMid": tgt, "targetNote": cfg["target"][1],
                }
                # R4 — term premium z (5Y − policy, 3m rolling)
                r5y = self._swap_ric(cfg, "5Y")
                h5 = dvals(r5y) if r5y else []
                if h5 and p is not None:
                    srow["r4"] = {"z3m": _z([x - p for x in h5], 63),
                                  "tp": round(h5[-1] - p, 2)}
                else:
                    srow["r4"] = None
                # R5 — curve
                lo_t = "2Y" if curve.get("2Y") is not None else "1Y"
                lo, hi = curve.get(lo_t), curve.get("10Y")
                if lo is not None and hi is not None:
                    slope = round((hi - lo) * 100.0, 0)
                    hlo, hhi = dvals(self._swap_ric(cfg, lo_t)), dvals(self._swap_ric(cfg, "10Y"))
                    chg = None
                    if len(hlo) > 64 and len(hhi) > 64:
                        chg = round(((hhi[-1] - hlo[-1]) - (hhi[-64] - hlo[-64])) * 100.0, 0)
                    srow["r5"] = {"pair": f"{lo_t[0]}s10s", "slopeBp": slope, "chg3mBp": chg}
                else:
                    srow["r5"] = None
                # R8 — momentum + breadth (EM ccy return = −Δ USDXXX)
                sp = dvals(cfg["spot"])
                if len(sp) > 22:
                    mom = round((sp[-22] / sp[-1] - 1.0) * 100.0, 2)   # ccy appreciation %
                    rets = np.diff(np.log(sp[-22:]))
                    breadth = int(np.sum(rets < 0))                     # ccy up-days
                    srow["r8"] = {"mom1m": mom, "upDays21": breadth}
                else:
                    srow["r8"] = None
                # R11 — emergency-hike preconditions
                if len(sp) > 110:
                    rets = np.diff(np.log(sp))
                    sig = float(np.std(rets[-252:])) if len(rets) >= 252 else float(np.std(rets))
                    nsig = int(np.sum(np.abs(rets[-100:]) > sig)) if sig > 0 else None
                    srow["r11"] = {"sigmaMoves100d": nsig,
                                   "stressed": bool(nsig is not None and nsig > 30)}
                else:
                    srow["r11"] = None
                rows.append(srow)

            # R3 ranks (vs target where defined, else vs CPI)
            ranked = [r for r in rows if r["r3"]["real"] is not None]
            ranked.sort(key=lambda r: -(r["r3"]["realVsTarget"]
                                        if r["r3"]["realVsTarget"] is not None
                                        else r["r3"]["real"]))
            for i, r in enumerate(ranked):
                r["r3"]["rank"] = i + 1

            # ── House RATES-direction score (NOT from the book): unweighted vote
            # over the rates rules. Positive = receive bias, negative = pay bias.
            #   R1 RECEIVE +2 / PAY −2 · R2 peaked +1, rising −1 ·
            #   R3 rank top-3 +1 / bottom-3 −1 · R4 z>1 +1 · R11 stressed −1.
            # Missing rules contribute nothing (parts lists what actually voted);
            # score is None when no rule computed — never a defaulted zero.
            n_ranked = len(ranked)
            for r in rows:
                parts: Dict[str, int] = {}
                r1s, r2s, r3s = r.get("r1"), r.get("r2"), r.get("r3") or {}
                r4s, r11s = r.get("r4"), r.get("r11")
                if r1s:
                    parts["r1"] = (2 if r1s.get("state") == "RECEIVE"
                                   else -2 if r1s.get("state") == "PAY" else 0)
                if r2s is not None:
                    # peaked +1 · RISING −1 · flat 0 (steady-state inflation is no signal)
                    parts["r2"] = 1 if r2s.get("peaked") else (-1 if r2s.get("rising") else 0)
                if r3s.get("rank") is not None and n_ranked >= 6:
                    parts["r3"] = (1 if r3s["rank"] <= 3
                                   else -1 if r3s["rank"] > n_ranked - 3 else 0)
                if r4s and r4s.get("z3m") is not None:
                    parts["r4"] = 1 if r4s["z3m"] > 1 else 0
                if r11s and r11s.get("sigmaMoves100d") is not None:
                    # explicit 0 when computed-and-calm, so the hover can tell
                    # "voted 0" from "not computable" (mirrors R4)
                    parts["r11"] = -1 if r11s.get("stressed") else 0
                r["score"] = ({"total": int(sum(parts.values())), "parts": parts}
                              if parts else None)

            payload = {
                "asOf": dt.datetime.now().isoformat(timespec="seconds"),
                "global": global_block,
                "countries": rows,
                "events": EVENTS,
                "buildSecs": round(time.time() - t0, 2),
                "notes": [
                    "Screener only — the book supplies the backtested evidence; verify before trading.",
                    "R1 'since' is approximate (1Y swap history vs CURRENT policy level).",
                    "Frontier names without swap curves show FX/inflation rules only.",
                    "R7 carry/vol comes from the Carry Basket service (frontend reads /api/carry/rank).",
                    "SCORE is a HOUSE composite (votes: R1 ±2 · R2 peaked +1 / rising −1 / flat 0 · R3 ±1 · R4 +1 · R11 −1) — not from the book; R11's vote uses only the σ-count half of the book's precondition.",
                ],
            }
            self._cache = payload
            self._cache_ts = time.time()
            return payload
