"""
RIC configuration for all FX currencies: NDFs + Deliverable pairs.

RIC conventions on LSEG / Workspace:

NDF SWAP POINTS (primary — what the market trades):
  {CCY}{tenor}NDF=        e.g. TWD1MNDF=, KRW3MNDF=   (composite)
  {CCY}{tenor}NDF={broker} e.g. TWD1MNDF=BGCP           (broker-contributed)

NDF OUTRIGHTS (derived — spot + points):
  {CCY}{tenor}NDFOR=      e.g. TWD1MNDFOR=              (composite outright)

Deliverable FWD POINTS (primary — what the market trades):
  {CCY}{tenor}=           e.g. SGD1M=, THB3M=           (composite fwd points)
  {CCY}{tenor}={broker}   e.g. SGD1M=BGCP               (broker-contributed)

Spot:
  {CCY}=                  e.g. TWD=, KRW=     (NDF reference spot)
  USD{CCY}=               e.g. USDCNH=        (deliverable spot — some use {CCY}=)

SOFR OIS:
  USDSROIS{tenor}=        e.g. USDSROIS1M=, USDSROIS1Y=

Pip factors (convert price-difference to market-convention "pips" / "points"):
  The pip_factor is used to convert between outright price differences and
  the swap points convention the market quotes. For most pairs:
    swap_points = (outright - spot) * pip_factor
    outright = spot + swap_points / pip_factor
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional

# Full tenor set — used for SOFR mapping. Per-currency anchor tenors live in CurrencyConfig.
ALL_TENORS_M = [1, 2, 3, 6, 9, 12, 18, 24]
FULL_TENORS_M = [0, 1, 2, 3, 6, 9, 12, 18, 24]  # include spot (0)

# Weekly tenors as month fractions: 1W≈0.25, 2W≈0.5, 3W≈0.75
WEEKLY_TENORS = [0.25, 0.5, 0.75]
ALL_TENORS_INCL_WEEKLY = [0.25, 0.5, 0.75] + ALL_TENORS_M

# Funding tenors for deliverables (days): ON=overnight, TN=tomorrow-next, SN=spot-next
FUNDING_TENORS = ["ON", "TN", "SN"]

# ─────────────────────────────────────────────────────────────
# SPREAD PACK DEFINITIONS
# ─────────────────────────────────────────────────────────────

# NDF spread pack (relative-value traded interbank — 1M forward-starting)
NDF_SPREAD_PACK = [
    ("1Wx1M", 0, 1, "1W", "1M"),
    ("1Mx2M", 1, 2, "1M", "2M"),
    ("1Mx3M", 1, 3, "1M", "3M"),
    ("1Mx6M", 1, 6, "1M", "6M"),
    ("1Mx9M", 1, 9, "1M", "9M"),
    ("1Mx12M", 1, 12, "1M", "12M"),
    ("3Mx6M", 3, 6, "3M", "6M"),
    ("6Mx9M", 6, 9, "6M", "9M"),
    ("9Mx12M", 9, 12, "9M", "12M"),
    ("12Mx18M", 12, 18, "12M", "18M"),
    ("12Mx24M", 12, 24, "12M", "24M"),
]

# Deliverable anchor spreads — SPOT-START (this is how deliverables trade interbank)
DELIVERABLE_ANCHOR_SPREADS = [
    ("SPx1M", 0, 1, "Spot", "1M"),
    ("SPx2M", 0, 2, "Spot", "2M"),
    ("SPx3M", 0, 3, "Spot", "3M"),
    ("SPx6M", 0, 6, "Spot", "6M"),
    ("SPx9M", 0, 9, "Spot", "9M"),
    ("SPx12M", 0, 12, "Spot", "12M"),
    ("SPx18M", 0, 18, "Spot", "18M"),
    ("SPx24M", 0, 24, "Spot", "24M"),
]

# Deliverable fwd-fwd rolls (occasionally traded)
DELIVERABLE_FWDFWD = [
    ("1Mx2M", 1, 2, "1M", "2M"),
    ("2Mx3M", 2, 3, "2M", "3M"),
    ("3Mx6M", 3, 6, "3M", "6M"),
    ("6Mx9M", 6, 9, "6M", "9M"),
    ("9Mx12M", 9, 12, "9M", "12M"),
    ("12Mx18M", 12, 18, "12M", "18M"),
    ("18Mx24M", 18, 24, "18M", "24M"),
]

# Broker contributors — realtime snap RICs on LSEG
BROKER_CONTRIBUTORS = ["ICAP", "BGCP", "TRDS", "TPTS"]

# NDF live spread composite RICs (market-traded spreads)
NDF_SPREAD_RICS = {
    "TWD": "TWDNDFSPRd=R",
    "KRW": "KRWNDFSPRd=R",
    "INR": "INRNDFSPRd=R",
    "IDR": "IDRNDFSPRd=R",
    "PHP": "PHPNDFSPRd=R",
    "CNY": "CNYNDFSPRd=R",
    "MYR": "MYRNDFSPRd=R",
    "NGN": "NGNNDFSPRd=R",
    "EGP": "EGPNDFSPRd=R",
    "CLP": "CLPNDFSPRd=R",
    "COP": "COPNDFSPRd=R",
}

# SOFR fields for price extraction
SOFR_FIELDS = ["BID", "ASK", "PRIMACT_1", "SEC_ACT_1", "TRDPRC_1", "HST_CLOSE", "GEN_VAL1", "TIMACT"]


@dataclass
class CurrencyConfig:
    code: str                   # "TWD"
    pair: str                   # "USDTWD"
    kind: str                   # "NDF" or "DELIVERABLE"
    pip_factor: float           # conversion outright-diff → market-convention points
    outright_dp: int            # decimal places for outright display
    pip_dp: int                 # decimal places for swap points display
    anchor_tenors_m: List[int]  # only tenors with real LSEG RICs
    max_display_m: int          # max display range (for interpolation)
    spot_ric: str               # "TWD=" or "USDCNH="
    spread_pack: str            # "NDF" or "DELIVERABLE"

    @property
    def display_tenors(self):
        """Tenors for display including weekly (interpolated from monthly)."""
        return WEEKLY_TENORS + self.anchor_tenors_m

    def swap_points_ric(self, tenor_m: int) -> str:
        """Return composite swap points RIC for a given tenor.
        This is the PRIMARY data source — what the market actually trades."""
        tenor_str = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{tenor_str}NDF="
        else:
            # Deliverable forward points: {CCY}{tenor}= e.g. SGD1M=
            return f"{self.code}{tenor_str}="

    def outright_ric(self, tenor_m: int) -> str:
        """Return composite outright RIC (for reference / cross-check).
        For NDFs: {CCY}{tenor}NDFOR=  For deliverables: not typically used."""
        tenor_str = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{tenor_str}NDFOR="
        else:
            return f"{self.code}{tenor_str}="

    def broker_ric(self, tenor_m: int, contributor: str) -> str:
        """Return broker-contributed swap points RIC for realtime snap."""
        tenor_str = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{tenor_str}NDF={contributor}"
        else:
            return f"{self.code}{tenor_str}={contributor}"

    def funding_ric(self, tenor: str) -> str:
        """Return funding tenor RIC (ON/TN/SN) — deliverables only."""
        if self.kind == "NDF":
            return None
        # e.g. USDSGDON=, USDSGDTN=, USDSGDSN=
        return f"{self.pair}{tenor}="


def _tenor_str(m) -> str:
    """Format tenor int or float (months) to RIC tenor code."""
    if m == 0:
        return ""  # spot
    if m == 0.25:
        return "1W"
    if m == 0.5:
        return "2W"
    if m == 0.75:
        return "3W"
    if isinstance(m, float):
        m = int(m)
    if m < 12:
        return f"{m}M"
    if m == 12:
        return "1Y"
    if m == 18:
        return "18M"
    if m == 24:
        return "2Y"
    return f"{m}M"


# ═════════════════════════════════════════════════════════════════════
# CURRENCY UNIVERSE
# ═════════════════════════════════════════════════════════════════════
# pip_factor: converts outright price diff to market-convention points
# outright_dp: decimal places for outright price display
# pip_dp: decimal places for swap points display
#
# The pip_factor encodes the market quoting convention:
#   TWD (spot ~32.xxx):  points quoted as 50.0 meaning +0.050 → PF=1e3
#   KRW (spot ~1350.xx): points quoted as 3.50 meaning +3.50  → PF=1e0 (whole won)
#                         BUT interbank quotes in 0.01 (jeon) → PF=1e2
#   INR (spot ~83.xxxx): points quoted in paise (0.01) → PF=1e2
#   IDR (spot ~15800):   points in whole rupiah → PF=1e0
#   PHP (spot ~56.xxx):  points in centavos → PF=1e2
#   CNY/CNH (spot ~7.xxxx): points in 0.0001 (pip) → PF=1e4
#   SGD (spot ~1.3xxx):  points in 0.0001 (pip) → PF=1e4
#   THB (spot ~35.xx):   points in satang (0.01) → PF=1e2
#   MYR (spot ~4.xxxx):  points in 0.0001 → PF=1e4
#   HKD (spot ~7.78xx):  points in 0.0001 (pip) → PF=1e4
#   MXN (spot ~17.xxxx): points in 0.0001 (pip) → PF=1e4
#   ZAR (spot ~18.xxxx): points in centavos (0.01) → PF=1e2
#   TRY (spot ~32.xxxx): points in kurus (0.01) → PF=1e2
#   CLP (spot ~900.x):   points in whole peso → PF=1e0
#   COP (spot ~4200):    points in whole peso → PF=1e0

CURRENCIES: Dict[str, CurrencyConfig] = {
    # ═══════ NDFs ═══════
    "TWD": CurrencyConfig("TWD", "USDTWD", "NDF", 1e3, 3, 1, [1,2,3,6,9,12,24], 24, "TWD=", "NDF"),
    "KRW": CurrencyConfig("KRW", "USDKRW", "NDF", 1e2, 2, 2, [1,2,3,6,9,12,24], 24, "KRW=", "NDF"),
    "INR": CurrencyConfig("INR", "USDINR", "NDF", 1e2, 4, 2, [1,3,6,12], 12, "INR=", "NDF"),
    "IDR": CurrencyConfig("IDR", "USDIDR", "NDF", 1e0, 0, 0, [1,3,6,12], 12, "IDR=", "NDF"),
    "PHP": CurrencyConfig("PHP", "USDPHP", "NDF", 1e2, 3, 2, [1,3,6,12], 12, "PHP=", "NDF"),
    "CNY": CurrencyConfig("CNY", "USDCNY", "NDF", 1e4, 4, 1, [1,2,3,6,9,12,18,24], 24, "CNY=", "NDF"),
    "MYR": CurrencyConfig("MYR", "USDMYR", "NDF", 1e4, 4, 1, [1,2,3,6,9,12,18,24], 24, "MYR=", "NDF"),
    "NGN": CurrencyConfig("NGN", "USDNGN", "NDF", 1e0, 2, 0, [1,3,6,12], 12, "NGN=", "NDF"),
    "EGP": CurrencyConfig("EGP", "USDEGP", "NDF", 1e2, 4, 2, [1,3,6,12], 12, "EGP=", "NDF"),
    "CLP": CurrencyConfig("CLP", "USDCLP", "NDF", 1e0, 2, 0, [1,3,6,12], 12, "CLP=", "NDF"),
    "COP": CurrencyConfig("COP", "USDCOP", "NDF", 1e0, 0, 0, [1,3,6,12], 12, "COP=", "NDF"),

    # ═══════ Deliverables ═══════
    "CNH": CurrencyConfig("CNH", "USDCNH", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12,18,24], 24, "CNH=", "DELIVERABLE"),
    "SGD": CurrencyConfig("SGD", "USDSGD", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12,18,24], 24, "SGD=", "DELIVERABLE"),
    "HKD": CurrencyConfig("HKD", "USDHKD", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12,18,24], 24, "HKD=", "DELIVERABLE"),
    "MXN": CurrencyConfig("MXN", "USDMXN", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12], 12, "MXN=", "DELIVERABLE"),
    "ZAR": CurrencyConfig("ZAR", "USDZAR", "DELIVERABLE", 1e2, 4, 2, [1,2,3,6,9,12], 12, "ZAR=", "DELIVERABLE"),
    "TRY": CurrencyConfig("TRY", "USDTRY", "DELIVERABLE", 1e2, 4, 2, [1,2,3,6,9,12], 12, "TRY=", "DELIVERABLE"),
    "THB": CurrencyConfig("THB", "USDTHB", "DELIVERABLE", 1e2, 2, 2, [1,2,3,6,9,12], 12, "THB=", "DELIVERABLE"),
    "KZT": CurrencyConfig("KZT", "USDKZT", "DELIVERABLE", 1e2, 2, 2, [1,3,6,12], 12, "KZT=", "DELIVERABLE"),
    "RUB": CurrencyConfig("RUB", "USDRUB", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "RUB=", "DELIVERABLE"),
    "CZK": CurrencyConfig("CZK", "USDCZK", "DELIVERABLE", 1e3, 3, 1, [1,2,3,6,9,12], 12, "CZK=", "DELIVERABLE"),
    "ILS": CurrencyConfig("ILS", "USDILS", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12], 12, "ILS=", "DELIVERABLE"),
    "RON": CurrencyConfig("RON", "USDRON", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12], 12, "RON=", "DELIVERABLE"),
    "PLN": CurrencyConfig("PLN", "USDPLN", "DELIVERABLE", 1e4, 4, 1, [1,2,3,6,9,12], 12, "PLN=", "DELIVERABLE"),
    "HUF": CurrencyConfig("HUF", "USDHUF", "DELIVERABLE", 1e2, 2, 2, [1,2,3,6,9,12], 12, "HUF=", "DELIVERABLE"),
    "UGX": CurrencyConfig("UGX", "USDUGX", "DELIVERABLE", 1e0, 0, 0, [1,3,6,12], 12, "UGX=", "DELIVERABLE"),
    "MUR": CurrencyConfig("MUR", "USDMUR", "DELIVERABLE", 1e2, 2, 2, [1,3,6,12], 12, "MUR=", "DELIVERABLE"),
    "BWP": CurrencyConfig("BWP", "USDBWP", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "BWP=", "DELIVERABLE"),
    "SAR": CurrencyConfig("SAR", "USDSAR", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "SAR=", "DELIVERABLE"),
    "AED": CurrencyConfig("AED", "USDAED", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "AED=", "DELIVERABLE"),
    "MAD": CurrencyConfig("MAD", "USDMAD", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "MAD=", "DELIVERABLE"),
    "TND": CurrencyConfig("TND", "USDTND", "DELIVERABLE", 1e3, 3, 1, [1,3,6,12], 12, "TND=", "DELIVERABLE"),
    "QAR": CurrencyConfig("QAR", "USDQAR", "DELIVERABLE", 1e4, 4, 1, [1,3,6,12], 12, "QAR=", "DELIVERABLE"),
}

NDF_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "NDF"]
DELIVERABLE_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "DELIVERABLE"]

# USD SOFR OIS curve RICs for implied-yield decomposition (shared across ccys)
SOFR_RICS = {
    1: "USDSROIS1M=",   2: "USDSROIS2M=",   3: "USDSROIS3M=",
    6: "USDSROIS6M=",   9: "USDSROIS9M=",   12: "USDSROIS1Y=",
    18: "USDSROIS18M=", 24: "USDSROIS2Y=",
}


# ═════════════════════════════════════════════════════════════════════
# RIC GENERATORS
# ═════════════════════════════════════════════════════════════════════

def all_swap_points_rics(ccy: str) -> List[str]:
    """Return list of swap points RICs for a currency (primary data source)."""
    cfg = CURRENCIES[ccy]
    rics = [cfg.spot_ric]
    rics.extend(cfg.swap_points_ric(m) for m in cfg.anchor_tenors_m)
    return rics


def all_outright_rics(ccy: str) -> List[str]:
    """Return list of outright RICs for a currency (reference only for NDFs)."""
    cfg = CURRENCIES[ccy]
    rics = [cfg.spot_ric]
    rics.extend(cfg.outright_ric(m) for m in cfg.anchor_tenors_m)
    return rics


def all_broker_rics(ccy: str) -> List[str]:
    """Return all broker-contributed swap points RICs for a currency."""
    cfg = CURRENCIES[ccy]
    rics = []
    for m in cfg.anchor_tenors_m:
        for contrib in BROKER_CONTRIBUTORS:
            rics.append(cfg.broker_ric(m, contrib))
    return rics


def all_funding_rics(ccy: str) -> List[str]:
    """Return funding tenor RICs (ON/TN/SN) for deliverable currencies."""
    cfg = CURRENCIES[ccy]
    if cfg.kind != "DELIVERABLE":
        return []
    rics = []
    for tenor in FUNDING_TENORS:
        ric = cfg.funding_ric(tenor)
        if ric:
            rics.append(ric)
    return rics


def get_spread_pack(ccy: str):
    """Return spread-pack definitions based on currency kind."""
    cfg = CURRENCIES[ccy]
    if cfg.spread_pack == "NDF":
        return NDF_SPREAD_PACK
    else:
        # Deliverable: spot-start as anchor spreads + fwd-fwd rolls
        return DELIVERABLE_ANCHOR_SPREADS + DELIVERABLE_FWDFWD
