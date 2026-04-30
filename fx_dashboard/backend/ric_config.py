"""
RIC configuration — FX dashboard.

Empirically-verified conventions (probed against live LSEG Workspace):

SWAP-POINT VALUE CONVENTIONS
  Two conventions exist across ccys/sources. Each (ccy, source) pair declares
  one of:
    - "pips"    : raw LSEG value is already in market-convention pips.
                  outright = spot + raw / pip_factor
                  display   = raw
    - "outright": raw LSEG value equals outright - spot (absolute diff).
                  outright = spot + raw
                  display   = raw * pip_factor

  Why source-dependent: MXN composite (NAB) returns 0.0005 (pesos, "outright"
  mode) while MXN BGCP returns 14 (pips). Same tenor, same currency, different
  scale per feed. pip_factor = 10^(# decimal places between outright price
  and a single market-convention pip).

NDF SWAP POINTS  (primary: what market trades):
  {CCY}{tenor}NDF=            composite, e.g. TWD1MNDF=
  {CCY}{tenor}NDF={broker}    broker-contributed, e.g. INR1MNDF=TDS
  Special: NDF 18M composite does not exist — only broker RICs.
  Special: NGN NDF composite is null — derive from outrights.

NDF OUTRIGHTS:
  {CCY}{tenor}NDFOR=          composite outright (some ccys only)
  {CCY}{tenor}NDFOR={broker}  broker outright (e.g. NGN*NDFOR=MBGL)

DELIVERABLE FWD POINTS:
  {CCY}{tenor}=               composite, e.g. SGD1M=
  {CCY}{tenor}={broker}       e.g. SGD1M=BGCP

SPOT:
  {CCY}=   (NDF ref spot)   |   USD{CCY}= for some deliverables; most use {CCY}=

FUNDING TENORS (deliverables ON/TN/SN):
  {CCY}{ON|TN|SN}=            NOT USD{CCY}{T}= — that's the previous bug
  {CCY}{T}={broker}           broker variants work here too

WEEKLY NDF TENORS:
  {CCY}SWNDF=                 single "spot-week" code; 1W/2W/3W variants don't exist
  Deliverables: {CCY}SW=, {CCY}2W=, {CCY}3W= all work.

SOFR OIS:  USDSROIS{tenor}=
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple

# ─────────────────────────────────────────────────────────────
# TENORS
# ─────────────────────────────────────────────────────────────
ALL_TENORS_M = [1, 2, 3, 6, 9, 12, 18, 24]
FULL_TENORS_M = [0] + ALL_TENORS_M

# Weekly tenors represented in months. NDFs effectively collapse to a single
# "SW" code — we keep 1W display but map to SW under the hood for NDFs.
WEEKLY_TENORS = [0.25, 0.5, 0.75]

FUNDING_TENORS = ["ON", "TN", "SN"]

# ─────────────────────────────────────────────────────────────
# SPREAD PACKS — named, per-kind. Row tuple: (label, near_months, far_months,
# near_label, far_label). Fractional months allowed for sub-monthly rows.
# Months: 0.25/0.5/0.75 = 1W/2W/3W, ints = months. String tokens "ON","TN",
# "SP","SN" are allowed for deliverable funding rows.
# ─────────────────────────────────────────────────────────────

# NDF: interbank-tradable spot-start spreads (1M-anchored) — these are the
# spreads dealers actually quote.
NDF_INTERBANK_ANCHORS = [
    ("1Wx1M",              0.25,       1,           "1W",     "1M"),
    ("TOMFIXx(1M+1bd)",    1/30,       1 + 1/30,    "TOMFIX", "1M+1bd"),
    ("1Mx2M",              1,          2,           "1M",     "2M"),
    ("1Mx3M",              1,          3,           "1M",     "3M"),
    ("1Mx6M",              1,          6,           "1M",     "6M"),
    ("1Mx9M",              1,          9,           "1M",     "9M"),
    ("1Mx12M",             1,          12,          "1M",     "12M"),
    ("12Mx18M",            12,         18,          "12M",    "18M"),
    ("12Mx24M",            12,         24,          "12M",    "24M"),
]

# Full-curve: NDF spot-start ladder (anchor tenors only — Spot→T rows).
NDF_SPOT_START = [
    ("1M",   0, 1,   "Spot", "1M"),
    ("2M",   0, 2,   "Spot", "2M"),
    ("3M",   0, 3,   "Spot", "3M"),
    ("6M",   0, 6,   "Spot", "6M"),
    ("9M",   0, 9,   "Spot", "9M"),
    ("12M",  0, 12,  "Spot", "12M"),
    ("18M",  0, 18,  "Spot", "18M"),
    ("24M",  0, 24,  "Spot", "24M"),
]

# 1M chain (NDF) — includes weekly leg rolls then every month 1-24.
def _ndf_1m_chain():
    rows = [
        ("SPx1W", 0,    0.25, "Spot", "1W"),
        ("1Wx2W", 0.25, 0.5,  "1W", "2W"),
        ("2Wx3W", 0.5,  0.75, "2W", "3W"),
        ("3Wx1M", 0.75, 1,    "3W", "1M"),
    ]
    _lbl = lambda m: ("1Y" if m == 12 else "2Y" if m == 24 else f"{m}M")
    for n in range(1, 24):
        f = n + 1
        rows.append((f"{_lbl(n)}x{_lbl(f)}", n, f, _lbl(n), _lbl(f)))
    return rows

NDF_1M_CHAIN = _ndf_1m_chain()

# 3M chain — step-3 starting at 3M, out to 24M.
NDF_3M_CHAIN = [
    ("3Mx6M",   3,  6,  "3M",  "6M"),
    ("6Mx9M",   6,  9,  "6M",  "9M"),
    ("9Mx12M",  9,  12, "9M",  "12M"),
    ("12Mx15M", 12, 15, "12M", "15M"),
    ("15Mx18M", 15, 18, "15M", "18M"),
    ("18Mx21M", 18, 21, "18M", "21M"),
    ("21Mx24M", 21, 24, "21M", "24M"),
]

# Deliverable: full-curve spot-start anchors (8 rows).
DEL_SPOT_START = [
    ("SPx1M",   0, 1,   "Spot", "1M"),
    ("SPx2M",   0, 2,   "Spot", "2M"),
    ("SPx3M",   0, 3,   "Spot", "3M"),
    ("SPx6M",   0, 6,   "Spot", "6M"),
    ("SPx9M",   0, 9,   "Spot", "9M"),
    ("SPx12M",  0, 12,  "Spot", "12M"),
    ("SPx18M",  0, 18,  "Spot", "18M"),
    ("SPx24M",  0, 24,  "Spot", "24M"),
]

# Deliverable 1M chain — funding legs, weekly legs, then monthly rolls 1-24.
def _del_1m_chain():
    rows = [
        ("ONxTN", "ON", "TN", "ON", "TN"),
        ("TNxSP", "TN", "SP", "TN", "SP"),
        ("SPxSN", "SP", "SN", "SP", "SN"),
        ("SPx1W", 0,    0.25, "SP", "1W"),
        ("1Wx2W", 0.25, 0.5,  "1W", "2W"),
        ("2Wx3W", 0.5,  0.75, "2W", "3W"),
        ("3Wx1M", 0.75, 1,    "3W", "1M"),
    ]
    _lbl = lambda m: ("1Y" if m == 12 else "2Y" if m == 24 else f"{m}M")
    for n in range(1, 24):
        f = n + 1
        rows.append((f"{_lbl(n)}x{_lbl(f)}", n, f, _lbl(n), _lbl(f)))
    return rows

DEL_1M_CHAIN = _del_1m_chain()
DEL_3M_CHAIN = NDF_3M_CHAIN  # Same monthly step-3 shape

# Back-compat funding pack (still referenced by older frontend paths).
DEL_FUNDING = [
    ("ONxTN", "ON", "TN", "ON", "TN"),
    ("TNxSP", "TN", "SP", "TN", "SP"),
    ("SPxSN", "SP", "SN", "SP", "SN"),
]

# ── Back-compat aliases ─────────────────────────────────────
NDF_SPREAD_PACK = NDF_INTERBANK_ANCHORS + NDF_1M_CHAIN + NDF_3M_CHAIN
DELIVERABLE_ANCHOR_SPREADS = DEL_SPOT_START
DELIVERABLE_FWDFWD = DEL_1M_CHAIN


# ─────────────────────────────────────────────────────────────
# BROKER GROUPS + ALIASES
# ─────────────────────────────────────────────────────────────
# Each broker suffix is its OWN distinct source — never silently merged.
# `group` is a display label only; the suffix disambiguates which RIC feed.
#
# Examples:  Tradition has two feeds → TDS ("TradData") and TRDL (distinct screen).
#            Tullett has two feeds    → TPTS (London) and PYNY (NY).
#            GFI/GMGM shared.          Martin Brokers → MBGL (esp. NGN outrights).
#            Fenics → FMD (dominant for NDFs incl. universal 18M fallback).

BROKER_META: Dict[str, Dict[str, str]] = {
    "ICAP": {"group": "ICAP",      "label": "ICAP"},
    "BGCP": {"group": "BGC",       "label": "BGC"},
    "TDS":  {"group": "Tradition", "label": "Tradition (TDS)"},
    "TRDS": {"group": "Tradition", "label": "Tradition (TRDS)"},
    "TRDL": {"group": "Tradition", "label": "Tradition (TRDL)"},
    "TPTS": {"group": "Tullett",   "label": "Tullett (TPTS)"},
    "PYNY": {"group": "Tullett",   "label": "Tullett (PYNY)"},
    "GMGM": {"group": "GFI/GMG",   "label": "GFI/GMG"},
    "GFIF": {"group": "GFI/GMG",   "label": "GFI (GFIF)"},
    "FMD":  {"group": "Fenics",    "label": "Fenics (FMD)"},
    "MBGL": {"group": "Martin",    "label": "Martin Brokers"},
    "PREB": {"group": "Prebon",    "label": "Prebon"},
    # KZT-specific local brokers (most reliable for USDKZT per user).
    "SVKZ": {"group": "SVKZ",      "label": "SVKZ (KZT)"},
    "EUKZ": {"group": "EUKZ",      "label": "EUKZ (KZT)"},
}


# ─────────────────────────────────────────────────────────────
# SOFR
# ─────────────────────────────────────────────────────────────
SOFR_RICS = {
    1: "USDSROIS1M=",   2: "USDSROIS2M=",   3: "USDSROIS3M=",
    6: "USDSROIS6M=",   9: "USDSROIS9M=",   12: "USDSROIS1Y=",
    18: "USDSROIS18M=", 24: "USDSROIS2Y=",
}
SOFR_FIELDS = ["BID", "ASK", "PRIMACT_1", "SEC_ACT_1", "TRDPRC_1", "HST_CLOSE", "GEN_VAL1", "TIMACT"]


# ─────────────────────────────────────────────────────────────
# TENOR CODE HELPERS
# ─────────────────────────────────────────────────────────────
def _tenor_str(m) -> str:
    """
    Format tenor (months) → RIC tenor code.
    Verified against Workspace: 12 → '1Y', 24 → '2Y' — both '12M'/'24M'
    return no data on every RIC class (composite, deliverable, broker).
    """
    if m == 0:
        return ""
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


# ─────────────────────────────────────────────────────────────
# CURRENCY CONFIG
# ─────────────────────────────────────────────────────────────
@dataclass
class CurrencyConfig:
    code: str
    pair: str
    kind: str                     # "NDF" | "DELIVERABLE"
    pip_factor: float             # market-convention pip scale
    outright_dp: int
    pip_dp: int
    anchor_tenors_m: List[int]
    max_display_m: int
    spot_ric: str
    spread_pack: str

    # Primary-composite quote convention: "pips" or "outright".
    # Most ccys: "pips" (LSEG value already in market pips).
    # Small-magnitude ccys (TWD, IDR, PHP, CLP, COP, MXN, NGN, EGP):
    #   composite quotes in raw outright-diff → "outright".
    value_mode: str = "pips"

    # Broker SUFFIXES that actually carry data for this ccy
    # (verified against live Workspace). Order = preferred display order.
    brokers: List[str] = field(default_factory=list)

    # Broker-specific value_mode overrides. Defaults to value_mode.
    # E.g. MXN funding: NAB composite is "outright", BGCP/TDS are "pips".
    broker_value_mode: Dict[str, str] = field(default_factory=dict)

    # For NDF composite 18M: LSEG has no composite 18M RIC — if this is
    # non-empty, snapshot code will pull 18M from one of these broker
    # suffixes (in priority order) and mark tenor with `source=<broker>`.
    # Typical: ["FMD"] for NDFs.
    composite_18m_fallback_brokers: List[str] = field(default_factory=list)

    # Outright-derived mode: if True, compute swap pts = outright − spot
    # using broker outright RICs ({CCY}{T}NDFOR={broker}). Used for NGN
    # where composite swap-point RICs are all null.
    derive_from_outrights: bool = False
    outright_source_brokers: List[str] = field(default_factory=list)
    # For outright-derived mode: broker tenor codes use 1Y/2Y not 12M/24M
    outright_prefer_year_code: bool = False

    # NDF-only: weekly tenor collapses to single SW code (1W display label).
    ndf_weekly_single: bool = True

    # Extended tenors: full month range where at least one source (typically
    # Fenics FMD) has data. Pulled into snapshot so frontend can use real
    # values for 4M/5M/7M/8M/10M/11M/13-17M/19-23M instead of interpolating.
    # Defaulted per kind in __post_init__.
    extended_tenors_m: List[int] = field(default_factory=list)

    # Turn-date types this currency prices in. Subset of {"YE","QE","ME","LUNAR"}.
    # Empty -> use default in turns.turn_types_for(cfg) (per-ccy heuristic).
    # Override here when a desk view differs from the defaults (e.g. switch
    # off QE for an NDF where market clearly doesn't price quarter-ends).
    turn_types: List[str] = field(default_factory=list)

    def __post_init__(self):
        # Default extended-tenor set: every month 1-12 plus 15/18/21/24,
        # capped at max_display_m. Frontend uses this to know which months
        # a broker RIC (typically FMD) is expected to carry.
        if not self.extended_tenors_m:
            candidates = list(range(1, 13)) + [15, 18, 21, 24]
            self.extended_tenors_m = [m for m in candidates if m <= self.max_display_m]

    @property
    def display_tenors(self):
        """Display tenors = weekly + anchor months."""
        return WEEKLY_TENORS + self.anchor_tenors_m

    @property
    def pts_in_outright(self) -> bool:
        """Legacy flag — True iff primary value_mode == 'outright'."""
        return self.value_mode == "outright"

    # ──────── RIC builders ────────
    def swap_points_ric(self, tenor_m) -> str:
        s = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{s}NDF="
        return f"{self.code}{s}="

    def ndf_weekly_ric(self) -> Optional[str]:
        """Single NDF weekly RIC: {CCY}SWNDF=  (NDFs only)."""
        if self.kind != "NDF":
            return None
        return f"{self.code}SWNDF="

    def weekly_rics(self) -> Dict[str, str]:
        """Weekly RICs keyed by label ('SW','2W','3W').
        NDF: only SW (= {CCY}SWNDF=). Deliverable: SW, 2W, 3W (no 1W RIC)."""
        if self.kind == "NDF":
            return {"SW": f"{self.code}SWNDF="}
        return {
            "SW": f"{self.code}SW=",
            "2W": f"{self.code}2W=",
            "3W": f"{self.code}3W=",
        }

    def outright_ric(self, tenor_m, broker: Optional[str] = None) -> str:
        s = _tenor_str(tenor_m)
        if self.kind == "NDF":
            if broker:
                return f"{self.code}{s}NDFOR={broker}"
            return f"{self.code}{s}NDFOR="
        return f"{self.code}{s}="

    def broker_ric(self, tenor_m, broker: str) -> str:
        s = _tenor_str(tenor_m)
        if self.kind == "NDF":
            return f"{self.code}{s}NDF={broker}"
        return f"{self.code}{s}={broker}"

    def funding_ric(self, tenor: str, broker: Optional[str] = None) -> Optional[str]:
        """Deliverable ON/TN/SN — {code}{T}= with optional broker suffix."""
        if self.kind != "DELIVERABLE":
            return None
        base = f"{self.code}{tenor}="
        return f"{base}{broker}" if broker else base

    def value_mode_for(self, source: str) -> str:
        """Resolve value_mode for a named source ('composite' or broker suffix)."""
        if source == "composite":
            return self.value_mode
        return self.broker_value_mode.get(source, self.value_mode)


# ═════════════════════════════════════════════════════════════════════
# CURRENCY UNIVERSE  — value_mode + brokers verified live
# ═════════════════════════════════════════════════════════════════════
# value_mode rationale (spot-check / composite 1M raw value):
#   TWD 31.55 / −0.02        → "outright"   (spot + raw → 31.53 ✓)
#   IDR 17110 / 10           → "outright"
#   PHP 59.76 / 0.06         → "outright"
#   CLP 886.64 / −0.07       → "outright"
#   COP 3573 / 21            → "outright"
#   MXN 17.27 / 0.0465       → "outright"
#   KRW 1472 / −133          → "pips"       (raw/100 = −1.33 won ✓)
#   INR 93.1 / 46.6          → "pips"       (raw/100 paise)
#   CNY 6.82 / −277          → "pips"       (raw/1e4)
#   MYR 3.95 / −75           → "pips"
#   CNH 6.81 / −155          → "pips"
#   SGD 1.27 / −29           → "pips"
#   HKD 7.83 / −115          → "pips"
#   THB 31.97 / −2.71        → "pips"       (raw is satang-display; /100 → baht)
#   ZAR 16.34 / 368          → "pips" + PF=1e4 (was 1e2, wrong)
#   TRY 44.7  / 11042        → "pips" + PF=1e4 (was 1e2, wrong)
#   SAR 3.75  / 14           → "pips"
#   AED 3.67  / −7           → "pips"
#   NGN composite null       → outright-derived via MBGL
#   EGP composite null       → outright-derived via FMD/TDS/GMGM (value_mode pips via broker)

CURRENCIES: Dict[str, CurrencyConfig] = {
    # ═══════ NDFs ═══════
    "TWD": CurrencyConfig("TWD","USDTWD","NDF", 1e3, 3, 1,
        [1,2,3,6,9,12,18,24], 24, "TWD=", "NDF",
        value_mode="outright",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD","TDS"]),

    "KRW": CurrencyConfig("KRW","USDKRW","NDF", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "KRW=", "NDF",
        value_mode="pips",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "INR": CurrencyConfig("INR","USDINR","NDF", 1e2, 3, 2,
        [1,2,3,6,9,12,18,24], 24, "INR=", "NDF",
        value_mode="pips",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "IDR": CurrencyConfig("IDR","USDIDR","NDF", 1e0, 2, 0,
        [1,2,3,6,9,12,18,24], 24, "IDR=", "NDF",
        value_mode="outright",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "PHP": CurrencyConfig("PHP","USDPHP","NDF", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "PHP=", "NDF",
        value_mode="outright",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "CNY": CurrencyConfig("CNY","USDCNY","NDF", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "CNY=", "NDF",
        value_mode="pips",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD","TDS","BGCP"]),

    "MYR": CurrencyConfig("MYR","USDMYR","NDF", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "MYR=", "NDF",
        value_mode="pips",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "NGN": CurrencyConfig("NGN","USDNGN","NDF", 1e0, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "NGN=", "NDF",
        value_mode="outright",
        brokers=["MBGL"],
        derive_from_outrights=True,
        outright_source_brokers=["MBGL"],
        outright_prefer_year_code=True),  # NGN*NDFOR=MBGL uses 1Y/2Y

    "EGP": CurrencyConfig("EGP","USDEGP","NDF", 1e4, 4, 0,
        [1,2,3,6,9,12,18,24], 24, "EGP=", "NDF",
        value_mode="pips",
        brokers=["FMD","TDS","TRDS","TRDL","GMGM"],
        derive_from_outrights=True,
        outright_source_brokers=["FMD","TDS"]),

    "CLP": CurrencyConfig("CLP","USDCLP","NDF", 1e0, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "CLP=", "NDF",
        value_mode="outright",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    "COP": CurrencyConfig("COP","USDCOP","NDF", 1e0, 0, 0,
        [1,2,3,6,9,12,18,24], 24, "COP=", "NDF",
        value_mode="outright",
        brokers=["FMD","TDS","TRDS","TRDL","BGCP","ICAP","TPTS","PYNY","GMGM"],
        composite_18m_fallback_brokers=["FMD"]),

    # ═══════ Deliverables — Asia majors ═══════
    "CNH": CurrencyConfig("CNH","USDCNH","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "CNH=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "SGD": CurrencyConfig("SGD","USDSGD","DELIVERABLE", 1e4, 4, 2,  # 2dp on pts display per user
        [1,2,3,6,9,12,18,24], 24, "SGD=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "HKD": CurrencyConfig("HKD","USDHKD","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "HKD=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "THB": CurrencyConfig("THB","USDTHB","DELIVERABLE", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "THB=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    # ═══════ Deliverables — EM Tier 2 ═══════
    "MXN": CurrencyConfig("MXN","USDMXN","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "MXN=", "DELIVERABLE",
        value_mode="outright",                       # composite NAB quotes in pesos
        broker_value_mode={                          # brokers quote in pips
            "BGCP": "pips", "ICAP": "pips", "TDS": "pips", "TPTS": "pips",
        },
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "ZAR": CurrencyConfig("ZAR","USDZAR","DELIVERABLE", 1e4, 4, 1,  # was 1e2 (wrong)
        [1,2,3,6,9,12,18,24], 24, "ZAR=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "TRY": CurrencyConfig("TRY","USDTRY","DELIVERABLE", 1e4, 4, 1,  # was 1e2 (wrong)
        [1,2,3,6,9,12,18,24], 24, "TRY=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "CZK": CurrencyConfig("CZK","USDCZK","DELIVERABLE", 1e3, 3, 1,
        [1,2,3,6,9,12,18,24], 24, "CZK=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "ILS": CurrencyConfig("ILS","USDILS","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "ILS=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "RON": CurrencyConfig("RON","USDRON","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "RON=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "PLN": CurrencyConfig("PLN","USDPLN","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "PLN=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "HUF": CurrencyConfig("HUF","USDHUF","DELIVERABLE", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "HUF=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    # ═══════ Deliverables — Tier 3 / restricted ═══════
    "KZT": CurrencyConfig("KZT","USDKZT","DELIVERABLE", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "KZT=", "DELIVERABLE",
        value_mode="pips",
        # SVKZ + EUKZ are the most reliable KZT sources (local interbank).
        brokers=["SVKZ","EUKZ","BGCP","ICAP","TDS","PYNY","TPTS"]),

    "RUB": CurrencyConfig("RUB","USDRUB","DELIVERABLE", 1e4, 4, 1,
        # Was [1,3,6,12]/max=12 — restored to standard deliverable curve
        # so RUB renders the same Full Curve / Spreads tables as its peers.
        # Tenors with no data will render as "—" (acceptable; structure
        # consistency is the priority per user instruction).
        [1,2,3,6,9,12,18,24], 24, "RUB=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "UGX": CurrencyConfig("UGX","USDUGX","DELIVERABLE", 1e0, 0, 0,
        [1,2,3,6,9,12,18,24], 24, "UGX=", "DELIVERABLE",
        value_mode="outright",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "MUR": CurrencyConfig("MUR","USDMUR","DELIVERABLE", 1e2, 2, 2,
        [1,2,3,6,9,12,18,24], 24, "MUR=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "BWP": CurrencyConfig("BWP","USDBWP","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "BWP=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    # ═══════ Deliverables — GCC + North Africa ═══════
    "SAR": CurrencyConfig("SAR","USDSAR","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "SAR=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "AED": CurrencyConfig("AED","USDAED","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "AED=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "MAD": CurrencyConfig("MAD","USDMAD","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "MAD=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "TND": CurrencyConfig("TND","USDTND","DELIVERABLE", 1e3, 3, 1,
        [1,2,3,6,9,12,18,24], 24, "TND=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),

    "QAR": CurrencyConfig("QAR","USDQAR","DELIVERABLE", 1e4, 4, 1,
        [1,2,3,6,9,12,18,24], 24, "QAR=", "DELIVERABLE",
        value_mode="pips",
        brokers=["BGCP","ICAP","TDS","PYNY","TPTS"]),
}

NDF_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "NDF"]
DELIVERABLE_CURRENCIES = [c for c, cfg in CURRENCIES.items() if cfg.kind == "DELIVERABLE"]


# ─────────────────────────────────────────────────────────────
# RIC AGGREGATORS
# ─────────────────────────────────────────────────────────────
def all_swap_points_rics(ccy: str) -> List[str]:
    """Composite swap-point RICs (spot + each anchor tenor).
    For NDF 18M: composite doesn't exist — empty slot, filled via 18M broker fallback.
    For derive_from_outrights ccys (NGN): returns only spot (no composite swap points exist)."""
    cfg = CURRENCIES[ccy]
    rics: List[str] = [cfg.spot_ric]
    if cfg.derive_from_outrights:
        return rics
    for m in cfg.anchor_tenors_m:
        if cfg.kind == "NDF" and m == 18 and cfg.composite_18m_fallback_brokers:
            # 18M NDF has no composite — resolved via brokers in snapshot code
            continue
        rics.append(cfg.swap_points_ric(m))
    # Weekly NDF single RIC
    wk = cfg.ndf_weekly_ric()
    if wk:
        rics.append(wk)
    return rics


def all_outright_rics(ccy: str) -> List[str]:
    """Outright RICs for derive-from-outright ccys (NGN)."""
    cfg = CURRENCIES[ccy]
    if not cfg.derive_from_outrights:
        return []
    rics = []
    for m in cfg.anchor_tenors_m:
        for b in cfg.outright_source_brokers:
            rics.append(cfg.outright_ric(m, broker=b))
    return rics


def all_extended_rics(ccy: str) -> List[str]:
    """Composite + FMD broker RIC for every extended-tenor month that is NOT
    already an anchor. Frontend uses these as real data points; snapshot pulls
    them in the T fetch. Skips months the primary feed is known-null for."""
    cfg = CURRENCIES[ccy]
    if cfg.derive_from_outrights:
        return []
    anchor_set = set(cfg.anchor_tenors_m)
    rics: List[str] = []
    for m in cfg.extended_tenors_m:
        if m in anchor_set:
            continue
        # Composite: per probe, works for 1-12, 15, 18, 21, 1Y, 2Y. For NDF,
        # null for 4,5,7,8,10,11. Always include — broker fills the gap.
        if cfg.kind == "NDF":
            # Only request composite for months we know it works.
            if m in (1, 2, 3, 6, 9, 12, 24):
                rics.append(cfg.swap_points_ric(m))
        else:
            rics.append(cfg.swap_points_ric(m))
        # FMD broker (NDF) or first broker (deliverable) fallback
        preferred = "FMD" if "FMD" in cfg.brokers else (cfg.brokers[0] if cfg.brokers else None)
        if preferred:
            rics.append(cfg.broker_ric(m, preferred))
    return rics


def all_weekly_rics(ccy: str) -> List[str]:
    cfg = CURRENCIES[ccy]
    return list(cfg.weekly_rics().values())


def all_broker_rics(ccy: str) -> List[str]:
    """All broker-tenor swap-point RICs for this ccy."""
    cfg = CURRENCIES[ccy]
    rics = []
    for m in cfg.anchor_tenors_m:
        for b in cfg.brokers:
            rics.append(cfg.broker_ric(m, b))
    return rics


def all_funding_rics(ccy: str) -> List[str]:
    """Funding ON/TN/SN — composite + all broker variants."""
    cfg = CURRENCIES[ccy]
    if cfg.kind != "DELIVERABLE":
        return []
    rics = []
    for t in FUNDING_TENORS:
        base = cfg.funding_ric(t)
        if base:
            rics.append(base)
            for b in cfg.brokers:
                rics.append(cfg.funding_ric(t, broker=b))
    return rics


def get_spread_pack(ccy: str):
    """Back-compat flat list (all packs concatenated, deduped by label)."""
    packs = get_spread_packs(ccy)
    seen = set()
    out = []
    for group in (packs.get("fullCurve") or {}, packs.get("spreadsRolls") or {}):
        for key, rows in group.items():
            for row in rows:
                if row[0] in seen:
                    continue
                seen.add(row[0])
                out.append(row)
    return out


def get_spread_packs(ccy: str) -> Dict[str, Dict[str, list]]:
    """
    Named spread packs for frontend, grouped by tab.

    NDF:
      fullCurve:    {spotStart, m1Chain, m3Chain}
      spreadsRolls: {interbankAnchors, imm}

    DELIVERABLE:
      fullCurve:    {spotStart, m1Chain, m3Chain}
      spreadsRolls: {imm}

    Each pack = list of tuples (label, near, far, near_label, far_label)
    where near/far are months (int/float) or string tokens for funding rows.
    """
    cfg = CURRENCIES[ccy]
    if cfg.kind == "NDF":
        return {
            "fullCurve": {
                "spotStart": list(NDF_SPOT_START),
                "m1Chain":   list(NDF_1M_CHAIN),
                "m3Chain":   list(NDF_3M_CHAIN),
            },
            "spreadsRolls": {
                "interbankAnchors": list(NDF_INTERBANK_ANCHORS),
                "imm":              [],  # populated by frontend from IMM_DATES
            },
        }
    return {
        "fullCurve": {
            "spotStart": list(DEL_SPOT_START),
            "m1Chain":   list(DEL_1M_CHAIN),
            "m3Chain":   list(DEL_3M_CHAIN),
        },
        "spreadsRolls": {
            "imm": [],
        },
    }


# Back-compat: some callers import BROKER_CONTRIBUTORS. Emit the union.
BROKER_CONTRIBUTORS = sorted({b for cfg in CURRENCIES.values() for b in cfg.brokers})
