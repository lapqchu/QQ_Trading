"""
RIC configuration for all FX currencies: NDFs + Deliverable pairs.

RIC conventions on LSEG / Workspace:
- NDF outrights:     {CCY}{tenor}NDFOR=   e.g. TWD1MNDFOR=, KRW3MNDFOR=
  (composite; broker contributors appended as =ICAP, =BGCP, =TRAD, =TPTS — REALTIME ONLY)
- Deliverable spot:  {PAIR}=               e.g. USDCNH=, USDSGD=
- Deliverable fwd:   {PAIR}{tenor}=        e.g. USDSGD1M=, USDTHB3M=
  (for forwards we typically use points RICs: {PAIR}{tenor}=  or the outright =D2 etc.
   Here we use points quoting convention matching desk practice.)

Pip factors (convert outright-diff to "pips"):
  TWD: 1e3   (quoted to 3dp)
  KRW: 1e2   (quoted to 2dp)
  INR: 1e4   (quoted to 4dp)
  IDR: 1e0   (quoted to 1dp — points already whole numbers)
  PHP: 1e3
  CNY: 1e4
  MYR: 1e4
  CNH: 1e4
  SGD: 1e4
  THB: 1e3
  KZT: 1e2
  RUB: 1e4
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional

# Canonical tenor set — all currencies use the same full curve now (per user instruction)
ALL_TENORS_M = [1, 2, 3, 6, 9, 12, 18, 24]   # outright anchors
FULL_TENORS_M = [0, 1, 2, 3, 6, 9, 12, 18, 24]  # include spot (0)

# NDF spread pack (relative-value traded interbank)
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

# Deliverable spread pack — straight tenors only + occasional fwd-fwds + IMMs
DELIVERABLE_STRAIGHT_TENORS = [
    ("SPx1M", 0, 1, "Spot", "1M"),
    ("SPx2M", 0, 2, "Spot", "2M"),
    ("SPx3M", 0, 3, "Spot", "3M"),
    ("SPx6M", 0, 6, "Spot", "6M"),
    ("SPx9M", 0, 9, "Spot", "9M"),
    ("SPx12M", 0, 12, "Spot", "12M"),
    ("SPx18M", 0, 18, "Spot", "18M"),
    ("SPx24M", 0, 24, "Spot", "24M"),
]

DELIVERABLE_FWDFWD = [
    ("1M fwd-fwd", 1, 2, "1M", "2M"),   # interbank 1M fwd-fwd
    ("3M fwd-fwd", 3, 6, "3M", "6M"),   # interbank 3M fwd-fwd
]

# Broker contributors — realtime-only snap RICs on LSEG
# Actual suffixes in Workspace (confirm with user): =ICAP, =BGCP, =TRAD (Tradition), =TPTS (Tullett)
BROKER_CONTRIBUTORS = ["ICAP", "BGCP", "TRAD", "TPTS"]


@dataclass
class CurrencyConfig:
    code: str                   # "TWD"
    pair: str                   # "USDTWD"
    kind: str                   # "NDF" or "DELIVERABLE"
    pip_factor: float           # conversion outright→pips
    outright_dp: int            # decimal places for outright display
    pip_dp: int                 # decimal places for pip display
    tenors_m: List[int]         # active tenor months (excluding spot)
    spot_ric: str               # "TWD=" or "USDCNH="
    # Spread pack type: NDF uses NDF_SPREAD_PACK; deliverable uses straight tenors + fwd-fwds
    spread_pack: str            # "NDF" or "DELIVERABLE"

    def outright_ric(self, tenor_m: int) -> str:
        """Return composite RIC for a given tenor (months)."""
        tenor_str = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{tenor_str}NDFOR="
        else:
            # Deliverable forward points RIC — e.g. SGD1M= (base ccy prefix only, no USD)
            # LSEG convention: points RIC uses the non-USD ccy code
            return f"{self.code}{tenor_str}="

    def broker_ric(self, tenor_m: int, contributor: str) -> str:
        """Return broker-contributed RIC for realtime snap."""
        tenor_str = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{tenor_str}NDFOR={contributor}"
        else:
            return f"{self.code}{tenor_str}={contributor}"


def _tenor_str(m: int) -> str:
    """Format tenor int (months) to RIC tenor code."""
    if m == 0:
        return ""  # spot
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
# All NDFs & deliverables share the full canonical tenor curve.
# Per-currency differences live in pip_factor / dp / spot RIC.

CURRENCIES: Dict[str, CurrencyConfig] = {
    # ───── NDFs ─────
    "TWD": CurrencyConfig("TWD", "USDTWD", "NDF", 1e3, 3, 1, ALL_TENORS_M, "TWD=", "NDF"),
    "KRW": CurrencyConfig("KRW", "USDKRW", "NDF", 1e2, 2, 1, ALL_TENORS_M, "KRW=", "NDF"),
    "INR": CurrencyConfig("INR", "USDINR", "NDF", 1e4, 4, 1, ALL_TENORS_M, "INR=", "NDF"),
    "IDR": CurrencyConfig("IDR", "USDIDR", "NDF", 1e0, 1, 1, ALL_TENORS_M, "IDR=", "NDF"),
    "PHP": CurrencyConfig("PHP", "USDPHP", "NDF", 1e3, 3, 1, ALL_TENORS_M, "PHP=", "NDF"),
    "CNY": CurrencyConfig("CNY", "USDCNY", "NDF", 1e4, 4, 1, ALL_TENORS_M, "CNY=", "NDF"),
    "MYR": CurrencyConfig("MYR", "USDMYR", "NDF", 1e4, 4, 1, ALL_TENORS_M, "MYR=", "NDF"),

    # ───── Deliverables ─────
    # CNH = offshore RMB (deliverable onshore-reference). Points convention uses CNH prefix.
    "CNH": CurrencyConfig("CNH", "USDCNH", "DELIVERABLE", 1e4, 4, 1, ALL_TENORS_M, "CNH=", "DELIVERABLE"),
    "SGD": CurrencyConfig("SGD", "USDSGD", "DELIVERABLE", 1e4, 4, 1, ALL_TENORS_M, "SGD=", "DELIVERABLE"),
    "THB": CurrencyConfig("THB", "USDTHB", "DELIVERABLE", 1e3, 3, 1, ALL_TENORS_M, "THB=", "DELIVERABLE"),
    "KZT": CurrencyConfig("KZT", "USDKZT", "DELIVERABLE", 1e2, 2, 1, ALL_TENORS_M, "KZT=", "DELIVERABLE"),
    "RUB": CurrencyConfig("RUB", "USDRUB", "DELIVERABLE", 1e4, 4, 1, ALL_TENORS_M, "RUB=", "DELIVERABLE"),
}

NDF_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "NDF"]
DELIVERABLE_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "DELIVERABLE"]

# USD SOFR OIS curve RICs for implied-yield decomposition (shared across ccys)
SOFR_RICS = {
    1: "USDSR1M=",   2: "USDSR2M=",   3: "USDSR3M=",
    6: "USDSR6M=",   9: "USDSR9M=",   12: "USDSR1Y=",
    18: "USDSR18M=", 24: "USDSR2Y=",
}


def all_outright_rics(ccy: str) -> List[str]:
    """Return list of outright RICs for a currency (all tenors incl spot)."""
    cfg = CURRENCIES[ccy]
    rics = [cfg.spot_ric]
    rics.extend(cfg.outright_ric(m) for m in cfg.tenors_m)
    return rics


def all_broker_rics(ccy: str) -> List[str]:
    """Return all broker-contributor RICs for a currency (for realtime subscription)."""
    cfg = CURRENCIES[ccy]
    rics = []
    for m in cfg.tenors_m:
        for contrib in BROKER_CONTRIBUTORS:
            rics.append(cfg.broker_ric(m, contrib))
    return rics


def get_spread_pack(ccy: str):
    """Return spread-pack definitions based on currency kind."""
    cfg = CURRENCIES[ccy]
    if cfg.spread_pack == "NDF":
        return NDF_SPREAD_PACK
    else:
        # Deliverable: straight tenors + fwd-fwds (IMM rolls added dynamically per-date)
        return DELIVERABLE_STRAIGHT_TENORS + DELIVERABLE_FWDFWD
