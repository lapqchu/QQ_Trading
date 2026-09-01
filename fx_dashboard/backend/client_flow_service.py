"""
Client Flow service — deep-dive tab backend (upload → sqlite → derived flows → panels).

The tab ingests a periodically-exported long CSV of client flow:
  [Pair] , View Type/Type (client segment), Time (DD/MM/YYYY HH:MM, ~3h buckets
  plus a 23:59 day-close row), cumUSD / "Cummulative USD (mio)" — a RUNNING
  CUMULATIVE net flow in USD millions with an unknown anchor. Everything level-
  based is therefore RELATIVE; per-bucket net flow is the first difference.

Design (see the tab's ⓘ manual for the trader-facing description):
  - Storage: stdlib sqlite (WAL), one transaction per ingest. NO parquet.
  - Git safety canary: the data dir must be gitignored and untracked or ALL
    ingest is refused — this is client data and must never reach the repo.
  - Two-phase ingest: preview (parse + QC + diff vs store + rebase/restatement
    classification) then commit; revert replays the revision log backwards.
  - Derived-flow engine: every first difference carries an explicit state
    (ok/close/overnight/offGrid/gapSpanned/seam) and each panel admits only the
    states it can use honestly. Missing data is NEVER filled — blank + flagged.
  - Sign convention: values stored raw; direction wording is gated on a one-time
    user confirmation stored in config (display-layer only).

House rules enforced throughout: no proxy/filler data (blank + flag), every
truncation/coverage limit visible in the payload (meta.flags), no workplace-
identifying wording anywhere.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import math
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time as _time
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

try:
    from scipy import stats as sps
except Exception:                                    # pragma: no cover
    sps = None

try:
    import holidays as _holidays
except Exception:                                    # pragma: no cover
    _holidays = None

from daycount import _CCY_CAL, _FRI_SAT_WEEKEND      # shared ccy→calendar map + weekend conventions

log = logging.getLogger("clientflow")

_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(_DIR, ".flow_data")
DB_PATH = os.path.join(DATA_DIR, "client_flow.db")

TS_FMT = "%d/%m/%Y %H:%M"          # strict export format — no dayfirst guessing
ISO_FMT = "%Y-%m-%dT%H:%M"
CLOSE_LABEL = "23:59"
BOOT_REPS = 2000
PREVIEW_TTL = 15 * 60

_PAIR_RE = re.compile(r"^USD[A-Z]{3}$")

# header-name → role (normalized: lower, collapsed spaces). Primary listed first.
_VAL_HEADERS = ("cumusd", "cummulative usd (mio)", "cumulative usd (mio)")
_TYPE_HEADERS = ("view type", "type")
_TIME_HEADERS = ("time",)
_PAIR_HEADERS = ("pair", "currency pair", "ccy pair")


# ─────────────────────────────────────────────────────────────
# small utilities
# ─────────────────────────────────────────────────────────────
def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def _ctype_key(label: str) -> str:
    return re.sub(r"\s+", " ", (label or "").strip().lower())


def _lev(a: str, b: str) -> int:
    """Levenshtein distance (small strings only — rename warnings)."""
    if a == b:
        return 0
    if not a or not b:
        return len(a) + len(b)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[-1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _bh_fdr(pvals: List[float]) -> List[float]:
    """Benjamini-Hochberg q-values (monotone step-up)."""
    n = len(pvals)
    if n == 0:
        return []
    order = sorted(range(n), key=lambda i: pvals[i])
    q = [0.0] * n
    prev = 1.0
    for rank_from_end, idx in enumerate(reversed(order)):
        rank = n - rank_from_end
        val = min(prev, pvals[idx] * n / rank)
        q[idx] = val
        prev = val
    return q


def _boot_ci(rows: np.ndarray, reps: int = BOOT_REPS, alpha: float = 0.05,
             rng_seed: int = 12345) -> Optional[Tuple[float, float]]:
    """Percentile bootstrap CI of the mean, resampling ROWS (days/events/months)
    — never individual buckets, which are dependent within a day."""
    x = rows[~np.isnan(rows)] if rows.ndim == 1 else rows
    n = x.shape[0]
    if n < 3:
        return None
    rng = np.random.default_rng(rng_seed + n)
    idx = rng.integers(0, n, size=(reps, n))
    means = np.nanmean(x[idx], axis=1) if x.ndim == 1 else np.nanmean(x[idx], axis=(1, 2))
    lo, hi = np.nanpercentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return float(lo), float(hi)


def _robust_z(x: float, hist: np.ndarray) -> Optional[float]:
    """(x − median) / (1.4826·MAD) vs a history vector; None when degenerate."""
    h = hist[~np.isnan(hist)]
    if h.size < 8:
        return None
    med = float(np.median(h))
    mad = float(np.median(np.abs(h - med)))
    if mad <= 0:
        return None
    return (x - med) / (1.4826 * mad)


class ParseError(Exception):
    """User-facing 422: the file cannot be ingested as-is (with the reason)."""


def _find_repo_root(start: str) -> Optional[str]:
    """Walk up from `start` looking for a .git dir/file (worktrees have a file).
    Pure-filesystem, so it works even when the git executable is not on the
    backend process's PATH (the office/Windows case)."""
    p = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent


# ─────────────────────────────────────────────────────────────
# the service
# ─────────────────────────────────────────────────────────────
class ClientFlowService:

    def __init__(self, db_path: str = DB_PATH, check_git: bool = True):
        self.db_path = db_path
        self.check_git = check_git
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._lock = threading.RLock()
        self._previews: Dict[str, Dict[str, Any]] = {}      # sha → {expires, parsed, meta}
        self._derived: Dict[Tuple[str, str], Dict[str, Any]] = {}   # (pair, ck) → {version, ...}
        self._git_safety_cache: Optional[Tuple[float, Dict[str, Any]]] = None
        self._spot_fetcher: Optional[Callable[[str], Dict[str, Any]]] = None
        self._us_cal = None
        self._local_cals: Dict[str, Any] = {}
        self._init_db()

    # ── storage ──────────────────────────────────────────────
    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.db_path)
        c.execute("PRAGMA journal_mode=WAL")
        c.row_factory = sqlite3.Row
        return c

    def _init_db(self) -> None:
        with self._conn() as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS flows (
              pair TEXT NOT NULL, ctype_key TEXT NOT NULL, ts TEXT NOT NULL,
              cum_usd REAL NOT NULL, upload_id INTEGER NOT NULL,
              PRIMARY KEY (pair, ctype_key, ts));
            CREATE TABLE IF NOT EXISTS client_types (
              ctype_key TEXT PRIMARY KEY, label TEXT, is_aggregate INTEGER, first_seen TEXT);
            CREATE TABLE IF NOT EXISTS uploads (
              id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, sha256 TEXT UNIQUE,
              uploaded_at TEXT, rows_added INT, rows_updated INT, rows_unchanged INT,
              rows_unusable INT, blank_cells INT, hash_cells INT, intra_file_conflicts INT,
              col_conflicts INT, restatement_count INT, restatement_max_abs REAL,
              rebase_detected INT, coverage_json TEXT, committed INT);
            CREATE TABLE IF NOT EXISTS revisions (
              upload_id INT, pair TEXT, ctype_key TEXT, ts TEXT, old_value REAL, new_value REAL);
            CREATE TABLE IF NOT EXISTS level_breaks (
              pair TEXT, ctype_key TEXT, ts TEXT, offset_est REAL, upload_id INT, kind TEXT);
            CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);
            """)
            if c.execute("SELECT 1 FROM config WHERE key='store_version'").fetchone() is None:
                c.execute("INSERT INTO config VALUES ('store_version','0')")
            if c.execute("SELECT 1 FROM config WHERE key='sign_convention'").fetchone() is None:
                c.execute("INSERT INTO config VALUES ('sign_convention','unconfirmed')")

    def _cfg(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._conn() as c:
            r = c.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default

    def _set_cfg(self, key: str, value: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO config VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (key, value))

    @property
    def store_version(self) -> int:
        return int(self._cfg("store_version", "0") or 0)

    def _bump_version(self, c: sqlite3.Connection) -> int:
        v = self.store_version + 1
        c.execute("UPDATE config SET value=? WHERE key='store_version'", (str(v),))
        self._derived.clear()
        return v

    # ── git safety canary ────────────────────────────────────
    def git_safety(self) -> Dict[str, Any]:
        """The canary protects one thing: .flow_data must never be committable.
        Decision table (office deployments are often a plain folder copy, and the
        backend process may not have git on ITS PATH even when a shell does):
          no enclosing .git anywhere        → OK (no repository to leak into)
          repo exists, gitignored+untracked → OK
          repo exists, not ignored/tracked  → REFUSE (the real danger)
          repo exists, cannot verify        → REFUSE with the specific reason
        """
        if not self.check_git:
            return {"ok": True, "reason": "custom db path — canary not applicable"}
        now = _time.time()
        if self._git_safety_cache and now - self._git_safety_cache[0] < 60:
            return self._git_safety_cache[1]

        repo_root = _find_repo_root(_DIR)
        if repo_root is None:
            result: Dict[str, Any] = {
                "ok": True,
                "reason": "not inside a git checkout — no repository to leak into"}
        else:
            git = shutil.which("git") or shutil.which("git.exe")
            if git is None:
                result = {"ok": False,
                          "reason": (f"a git checkout exists at {repo_root} but the git executable "
                                     "is not on the backend's PATH — cannot verify .flow_data is "
                                     "ignored. Fix the service PATH, or run the app from a folder "
                                     "outside any git checkout")}
            else:
                try:
                    # probe a hypothetical file INSIDE the dir: a `backend/.flow_data/`
                    # gitignore pattern (trailing slash) does not match the bare,
                    # possibly not-yet-created directory path itself
                    probe = os.path.join(DATA_DIR, "client_flow.db")
                    ign = subprocess.run([git, "-C", _DIR, "check-ignore", "-q", probe],
                                         capture_output=True, timeout=10)
                    tracked = subprocess.run([git, "-C", _DIR, "ls-files", "--", DATA_DIR],
                                             capture_output=True, timeout=10, text=True)
                    if ign.returncode == 0 and not (tracked.returncode == 0 and tracked.stdout.strip()):
                        result = {"ok": True}
                    elif ign.returncode == 1:
                        result = {"ok": False,
                                  "reason": ".flow_data is NOT gitignored — add `backend/.flow_data/` "
                                            "to .gitignore before uploading"}
                    elif tracked.returncode == 0 and tracked.stdout.strip():
                        result = {"ok": False,
                                  "reason": ".flow_data has TRACKED files — untrack them before uploading"}
                    else:
                        err = (ign.stderr or b"").decode(errors="replace").strip()
                        result = {"ok": False,
                                  "reason": f"git could not verify .flow_data ignore status ({err or 'rc ' + str(ign.returncode)}) — refusing ingest, verify by hand"}
                except Exception as e:
                    result = {"ok": False,
                              "reason": f"git safety check failed ({e}) — a checkout exists at {repo_root}, refusing ingest until verified"}
        self._git_safety_cache = (now, result)
        return result

    # ── holiday calendars (own objects, expand=True → any year) ──
    def _us(self):
        if self._us_cal is None and _holidays is not None:
            try:
                self._us_cal = _holidays.country_holidays("US")
            except Exception:
                self._us_cal = None
        return self._us_cal

    def _local(self, ccy: str):
        if ccy not in self._local_cals:
            cal = None
            if _holidays is not None:
                try:
                    if ccy == "EUR":
                        cal = _holidays.financial_holidays("ECB")
                    else:
                        iso = _CCY_CAL.get(ccy)
                        if iso:
                            cal = _holidays.country_holidays(iso)
                except Exception:
                    cal = None
            self._local_cals[ccy] = cal
        return self._local_cals[ccy]

    def _good_day(self, d: date, ccy: Optional[str]) -> bool:
        """Union-calendar good business day: local business weekday (Fri-Sat
        weekend markets handled) ∧ not US Sat/Sun ∧ not US/local holiday."""
        if d.weekday() >= 5:
            return False
        if ccy in _FRI_SAT_WEEKEND and d.weekday() == 4:
            return False
        us = self._us()
        if us is not None and d in us:
            return False
        if ccy:
            loc = self._local(ccy)
            if loc is not None and d in loc:
                return False
        return True

    # ── parser (spec §1.4) ───────────────────────────────────
    def parse_upload(self, data: bytes, filename: str,
                     pair_override: Optional[str] = None) -> Dict[str, Any]:
        if data[:4] == b"PK\x03\x04":
            raise ParseError("Excel file detected and openpyxl is not installed — re-save as CSV from Excel")
        if data[:4] == b"\xd0\xcf\x11\xe0":
            raise ParseError("Legacy .xls file detected — re-save as CSV from Excel")
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = data.decode("latin-1")

        lines = [ln for ln in text.splitlines()]
        hdr_i = next((i for i, ln in enumerate(lines) if ln.strip()), None)
        if hdr_i is None:
            raise ParseError("empty file")
        hdr_line = lines[hdr_i]
        delim = max("\t,;", key=hdr_line.count)
        if hdr_line.count(delim) < 2:
            raise ParseError("could not detect a delimiter (expected tab/comma/semicolon-separated columns)")

        reader = csv.reader(io.StringIO("\n".join(lines[hdr_i:])), delimiter=delim)
        headers = [_norm_header(h) for h in next(reader)]

        def cols(cands: Tuple[str, ...]) -> List[int]:
            out = []
            for cand in cands:
                out += [i for i, h in enumerate(headers) if h == cand and i not in out]
            return out

        pair_cols = cols(_PAIR_HEADERS)
        type_cols = cols(_TYPE_HEADERS)
        val_cols = cols(_VAL_HEADERS)
        time_cols = cols(_TIME_HEADERS)
        if not time_cols:
            raise ParseError(f"no Time column found (headers: {headers})")
        if not val_cols:
            raise ParseError(f"no value column found — expected one of {_VAL_HEADERS}")
        if not type_cols:
            raise ParseError(f"no client-type column found — expected one of {_TYPE_HEADERS}")
        if pair_cols and pair_override:
            raise ParseError("file has its own Pair column — the pair override is not allowed for this file")
        if not pair_cols and not pair_override:
            raise ParseError("file has no Pair column — pass pair=USDXXX on the upload")
        if pair_override and not _PAIR_RE.match(pair_override.upper()):
            raise ParseError(f"pair override '{pair_override}' is not a USDXXX pair")

        rows: Dict[Tuple[str, str, str], Tuple[float, str]] = {}
        counts = {"blank_cells": 0, "hash_cells": 0, "unusable": 0,
                  "col_conflicts": 0, "intra_file_conflicts": 0, "intra_file_max_abs": 0.0}
        n_data_rows = 0
        for rec in reader:
            if not any(x.strip() for x in rec):
                continue
            n_data_rows += 1

            def cell(i: int) -> str:
                return rec[i].strip() if i < len(rec) else ""

            # pair
            if pair_cols:
                pair = cell(pair_cols[0]).upper()
                if not _PAIR_RE.match(pair):
                    counts["unusable"] += 1
                    continue
            else:
                pair = pair_override.upper()

            # client type (duplicate columns must agree on canonical key)
            labels = [cell(i) for i in type_cols if cell(i)]
            if not labels:
                counts["unusable"] += 1
                continue
            keys = {_ctype_key(x) for x in labels}
            if len(keys) > 1:
                counts["col_conflicts"] += 1
                continue
            label = labels[0]
            ck = _ctype_key(label)

            # time — strict format; ######## and anything else unparseable counted
            traw = next((cell(i) for i in time_cols if cell(i)), "")
            if not traw or "#" in traw:
                counts["hash_cells" if "#" in traw else "unusable"] += 1
                continue
            try:
                ts = datetime.strptime(traw, TS_FMT)
            except ValueError:
                counts["unusable"] += 1
                continue

            # value — duplicate columns compared; blank = no observation
            vals: List[float] = []
            saw_hash = saw_blank = False
            for i in val_cols:
                v = cell(i)
                if v == "":
                    saw_blank = True
                elif "#" in v:
                    saw_hash = True
                else:
                    try:
                        vals.append(float(v.replace(",", "")))
                    except ValueError:
                        counts["unusable"] += 1
                        vals = []
                        break
                    continue
            if saw_hash and not vals:
                counts["hash_cells"] += 1
                continue
            if not vals:
                if saw_blank:
                    counts["blank_cells"] += 1
                continue
            if len(vals) > 1 and max(vals) - min(vals) > 1e-9:
                counts["col_conflicts"] += 1
                continue
            value = vals[0]

            key = (pair, ck, ts.strftime(ISO_FMT))
            if key in rows and abs(rows[key][0] - value) > 1e-9:
                counts["intra_file_conflicts"] += 1
                counts["intra_file_max_abs"] = max(counts["intra_file_max_abs"],
                                                   abs(rows[key][0] - value))
            rows[key] = (value, label)     # keep LAST occurrence

        return {"rows": rows, "counts": counts, "nDataRows": n_data_rows,
                "pairs": sorted({k[0] for k in rows}),
                "clientTypes": sorted({rows[k][1] for k in rows})}

    # ── ingest: preview / commit / revert (spec §1.5) ────────
    def preview(self, data: bytes, filename: str,
                pair_override: Optional[str] = None) -> Dict[str, Any]:
        safety = self.git_safety()
        if not safety["ok"]:
            raise ParseError(f"ingest disabled — git safety canary failed: {safety['reason']}")
        sha = hashlib.sha256(data).hexdigest()
        with self._conn() as c:
            dup = c.execute("SELECT id FROM uploads WHERE sha256=? AND committed=1", (sha,)).fetchone()
        if dup:
            return {"sha": sha, "verdict": "duplicate", "duplicateOf": dup["id"]}

        parsed = self.parse_upload(data, filename, pair_override)
        rows = parsed["rows"]

        rows_new = rows_changed = rows_unchanged = 0
        diffs: Dict[Tuple[str, str], List[Tuple[str, float, float]]] = {}
        with self._conn() as c:
            for (pair, ck, ts), (val, _lbl) in rows.items():
                r = c.execute("SELECT cum_usd FROM flows WHERE pair=? AND ctype_key=? AND ts=?",
                              (pair, ck, ts)).fetchone()
                if r is None:
                    rows_new += 1
                elif abs(r["cum_usd"] - val) <= 1e-9:
                    rows_unchanged += 1
                else:
                    rows_changed += 1
                    diffs.setdefault((pair, ck), []).append((ts, r["cum_usd"], val))
            existing_types = {r["ctype_key"]: r["label"] for r in
                              c.execute("SELECT ctype_key,label FROM client_types")}

        # classify overlap differences per series: rebase (near-constant offset) vs restatement
        rebases: List[Dict[str, Any]] = []
        restatement_count = 0
        restatement_max = 0.0
        for (pair, ck), lst in diffs.items():
            deltas = np.array([new - old for _, old, new in lst])
            levels = np.array([abs(old) for _, old, _ in lst])
            tol = max(0.1, 0.01 * float(np.median(levels)) if levels.size else 0.1)
            if deltas.size >= 3 and float(np.std(deltas)) < tol and abs(float(np.mean(deltas))) > tol:
                first_new = min((ts for (p, k, ts) in rows
                                 if p == pair and k == ck and
                                 not any(t == ts for t, _, _ in lst)), default=lst[-1][0])
                rebases.append({"pair": pair, "clientType": ck, "ts": first_new,
                                "offsetEst": float(np.mean(deltas))})
            else:
                restatement_count += len(lst)
                restatement_max = max(restatement_max, float(np.max(np.abs(deltas))) if deltas.size else 0.0)

        rename_warnings = []
        for lbl in parsed["clientTypes"]:
            ck = _ctype_key(lbl)
            if ck not in existing_types:
                for ek, el in existing_types.items():
                    if 0 < _lev(ck, ek) <= 2:
                        rename_warnings.append(f"possible rename: '{lbl}' vs existing '{el}'")

        coverage_delta: Dict[str, List[str]] = {}
        for pair in parsed["pairs"]:
            ts_list = sorted(ts for (p, _k, ts) in rows if p == pair)
            if ts_list:
                coverage_delta[pair] = [ts_list[0][:10], ts_list[-1][:10]]

        verdict = "rebase" if rebases else ("restatement" if restatement_count else "clean")
        meta = {"filename": filename, "counts": parsed["counts"],
                "rowsNew": rows_new, "rowsChanged": rows_changed, "rowsUnchanged": rows_unchanged,
                "rebases": rebases, "restatementCount": restatement_count,
                "restatementMaxAbs": restatement_max, "verdict": verdict}
        self._previews[sha] = {"expires": _time.time() + PREVIEW_TTL, "rows": rows, "meta": meta}
        self._previews = {k: v for k, v in self._previews.items() if v["expires"] > _time.time()}

        cts = parsed["counts"]
        return {
            "sha": sha, "verdict": verdict, "duplicateOf": None,
            "rowsNew": rows_new, "rowsChanged": rows_changed, "rowsUnchanged": rows_unchanged,
            "rowsUnusable": cts["unusable"], "blankCells": cts["blank_cells"],
            "hashCells": cts["hash_cells"], "colConflicts": cts["col_conflicts"],
            "intraFileConflicts": cts["intra_file_conflicts"],
            "handCopiedHint": cts["hash_cells"] > 0,
            "handCopiedNote": (f"file appears hand-copied from Excel rather than exported — "
                               f"re-export to recover the {cts['hash_cells']} masked values"
                               if cts["hash_cells"] else None),
            "restatement": {"count": restatement_count, "maxAbs": restatement_max},
            "rebase": rebases, "coverageDelta": coverage_delta,
            "pairsInFile": parsed["pairs"], "clientTypesInFile": parsed["clientTypes"],
            "typeRenameWarnings": sorted(set(rename_warnings)),
            "expires": datetime.fromtimestamp(self._previews[sha]["expires"]).strftime(ISO_FMT),
        }

    def commit(self, sha: str) -> Dict[str, Any]:
        pv = self._previews.get(sha)
        if not pv or pv["expires"] < _time.time():
            raise ParseError("preview expired or unknown — re-upload the file")
        safety = self.git_safety()
        if not safety["ok"]:
            raise ParseError(f"ingest disabled — git safety canary failed: {safety['reason']}")
        rows, meta = pv["rows"], pv["meta"]
        now = datetime.now().strftime(ISO_FMT)
        with self._lock, self._conn() as c:
            cts = meta["counts"]
            cur = c.execute(
                """INSERT INTO uploads (filename,sha256,uploaded_at,rows_added,rows_updated,
                   rows_unchanged,rows_unusable,blank_cells,hash_cells,intra_file_conflicts,
                   col_conflicts,restatement_count,restatement_max_abs,rebase_detected,
                   coverage_json,committed)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                (meta["filename"], sha, now, meta["rowsNew"], meta["rowsChanged"],
                 meta["rowsUnchanged"], cts["unusable"], cts["blank_cells"], cts["hash_cells"],
                 cts["intra_file_conflicts"], cts["col_conflicts"], meta["restatementCount"],
                 meta["restatementMaxAbs"], 1 if meta["rebases"] else 0,
                 json.dumps({p: 1 for p in {k[0] for k in rows}})))
            upload_id = cur.lastrowid
            for (pair, ck, ts), (val, lbl) in rows.items():
                old = c.execute("SELECT cum_usd FROM flows WHERE pair=? AND ctype_key=? AND ts=?",
                                (pair, ck, ts)).fetchone()
                if old is not None and abs(old["cum_usd"] - val) > 1e-9:
                    c.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)",
                              (upload_id, pair, ck, ts, old["cum_usd"], val))
                c.execute("""INSERT INTO flows VALUES (?,?,?,?,?)
                             ON CONFLICT(pair,ctype_key,ts) DO UPDATE
                             SET cum_usd=excluded.cum_usd, upload_id=excluded.upload_id""",
                          (pair, ck, ts, val, upload_id))
                if c.execute("SELECT 1 FROM client_types WHERE ctype_key=?", (ck,)).fetchone() is None:
                    c.execute("INSERT INTO client_types VALUES (?,?,?,?)",
                              (ck, lbl, 1 if ck == "all client types" else 0, now))
            for rb in meta["rebases"]:
                c.execute("INSERT INTO level_breaks VALUES (?,?,?,?,?,?)",
                          (rb["pair"], rb["clientType"], rb["ts"], rb["offsetEst"],
                           upload_id, "rebase"))
            version = self._bump_version(c)
        self._previews.pop(sha, None)
        return {"uploadId": upload_id, "storeVersion": version, **meta}

    def revert(self, upload_id: int) -> Dict[str, Any]:
        with self._lock, self._conn() as c:
            up = c.execute("SELECT * FROM uploads WHERE id=? AND committed=1", (upload_id,)).fetchone()
            if up is None:
                raise ParseError(f"upload {upload_id} not found or already reverted")
            revs = c.execute("SELECT * FROM revisions WHERE upload_id=?", (upload_id,)).fetchall()
            restored = 0
            for r in revs:
                c.execute("UPDATE flows SET cum_usd=? WHERE pair=? AND ctype_key=? AND ts=?",
                          (r["old_value"], r["pair"], r["ctype_key"], r["ts"]))
                restored += 1
            revised = {(r["pair"], r["ctype_key"], r["ts"]) for r in revs}
            added = c.execute("SELECT pair,ctype_key,ts FROM flows WHERE upload_id=?",
                              (upload_id,)).fetchall()
            deleted = 0
            for a in added:
                if (a["pair"], a["ctype_key"], a["ts"]) not in revised:
                    c.execute("DELETE FROM flows WHERE pair=? AND ctype_key=? AND ts=?",
                              (a["pair"], a["ctype_key"], a["ts"]))
                    deleted += 1
            c.execute("DELETE FROM level_breaks WHERE upload_id=?", (upload_id,))
            c.execute("UPDATE uploads SET committed=-1 WHERE id=?", (upload_id,))
            self._bump_version(c)
        return {"reverted": True, "rowsRestored": restored, "rowsDeleted": deleted}

    # ── derived-flow engine (spec §1.6) ──────────────────────
    def _series(self, pair: str, ck: str) -> List[Tuple[str, float]]:
        with self._conn() as c:
            return [(r["ts"], r["cum_usd"]) for r in
                    c.execute("SELECT ts,cum_usd FROM flows WHERE pair=? AND ctype_key=? ORDER BY ts",
                              (pair, ck))]

    def _breaks(self, pair: str, ck: str) -> List[Dict[str, Any]]:
        with self._conn() as c:
            return [dict(r) for r in
                    c.execute("SELECT ts,offset_est,kind FROM level_breaks WHERE pair=? AND ctype_key=? ORDER BY ts",
                              (pair, ck))]

    def derived(self, pair: str, ck: str) -> Dict[str, Any]:
        """Canonical derived frame: obs, stateful diffs, daily closes/flows, weekly rows.
        Cached per store_version; every panel slices THIS, so exclusions never diverge."""
        key = (pair, ck)
        cached = self._derived.get(key)
        if cached and cached["version"] == self.store_version:
            return cached
        obs = self._series(pair, ck)
        breaks = self._breaks(pair, ck)
        break_ts = sorted(b["ts"] for b in breaks)

        # grid inference: labels covering ≥90% of trailing-90d stamps (by count, desc)
        stamps = [ts for ts, _ in obs]
        grid: List[str] = []
        if stamps:
            cutoff = (datetime.strptime(stamps[-1], ISO_FMT) - timedelta(days=90)).strftime(ISO_FMT)
            recent = [ts[11:] for ts in stamps if ts >= cutoff and ts[11:] != CLOSE_LABEL]
            if recent:
                freq: Dict[str, int] = {}
                for lab in recent:
                    freq[lab] = freq.get(lab, 0) + 1
                total = len(recent)
                cum = 0
                for lab, n in sorted(freq.items(), key=lambda kv: -kv[1]):
                    grid.append(lab)
                    cum += n
                    if cum >= 0.9 * total:
                        break
                grid.sort()
        grid_set = set(grid)

        def n_slots_between(t0: datetime, t1: datetime) -> int:
            """Scheduled grid slots strictly inside (t0, t1] (close rows excluded)."""
            if not grid:
                return 1
            n = 0
            d = t0.date()
            while d <= t1.date():
                for lab in grid:
                    ti = datetime.strptime(f"{d.isoformat()}T{lab}", ISO_FMT)
                    if t0 < ti <= t1:
                        n += 1
                d += timedelta(days=1)
            return n

        # stateful first differences
        diffs: List[Dict[str, Any]] = []
        for i in range(1, len(obs)):
            ts0, v0 = obs[i - 1]
            ts1, v1 = obs[i]
            t0, t1 = datetime.strptime(ts0, ISO_FMT), datetime.strptime(ts1, ISO_FMT)
            crosses_break = any(ts0 < bt <= ts1 for bt in break_ts)
            lab0, lab1 = ts0[11:], ts1[11:]
            if crosses_break:
                state, flow = "seam", None
            else:
                flow = v1 - v0
                same_day = t0.date() == t1.date()
                if same_day and lab1 == CLOSE_LABEL:
                    state = "close"
                elif (not same_day) and (t1.date() - t0.date()).days == 1 and grid and lab1 == grid[0] and (lab0 == CLOSE_LABEL or lab0 in grid_set):
                    state = "overnight"
                elif lab1 not in grid_set or (lab0 not in grid_set and lab0 != CLOSE_LABEL):
                    state = "offGrid"
                else:
                    span = n_slots_between(t0, t1)
                    state = "ok" if same_day and span <= 1 else ("gapSpanned" if span > 1 or not same_day else "ok")
            diffs.append({"ts0": ts0, "ts1": ts1, "flow": flow, "state": state,
                          "span": n_slots_between(t0, t1) if flow is not None else 0})

        # daily closes + daily net flows
        by_day: Dict[str, Tuple[str, float]] = {}
        for ts, v in obs:
            by_day[ts[:10]] = (ts, v)                      # last obs of the day wins (sorted)
        days = sorted(by_day)
        daily: List[Dict[str, Any]] = []
        for i, d in enumerate(days):
            ts, v = by_day[d]
            row = {"date": d, "close": v, "partialClose": ts[11:] != CLOSE_LABEL,
                   "f": None, "spanDays": None, "state": None,
                   "nBuckets": sum(1 for df in diffs if df["ts1"][:10] == d and df["state"] in ("ok", "close", "overnight"))}
            if i > 0:
                pd_, (pts, pv) = days[i - 1], by_day[days[i - 1]]
                crosses = any(pts < bt <= ts for bt in break_ts)
                gap_days = (date.fromisoformat(d) - date.fromisoformat(pd_)).days
                if crosses:
                    row["state"] = "seam"
                else:
                    row["f"] = v - pv
                    row["spanDays"] = gap_days
                    row["state"] = "ok" if gap_days == 1 else "gapSpanned"
            daily.append(row)

        # weekly rows (week key = its Friday date; interval-end assignment)
        def week_key(d: date) -> str:
            return (d + timedelta(days=(4 - d.weekday()) % 7)).isoformat()

        wk: Dict[str, Dict[str, Any]] = {}
        for df in diffs:
            if df["flow"] is None:
                continue
            d1 = date.fromisoformat(df["ts1"][:10])
            w = wk.setdefault(week_key(d1), {"gross": 0.0, "nBuckets": 0, "spanning": 0})
            if df["state"] in ("ok", "close", "overnight"):
                w["gross"] += abs(df["flow"])
                w["nBuckets"] += 1
            elif df["state"] == "gapSpanned":
                d0 = date.fromisoformat(df["ts0"][:10])
                if week_key(d0) != week_key(d1):
                    w["spanning"] += 1
        # weekly net from Friday-close differences (robust to intra-week gaps)
        week_close: Dict[str, Tuple[str, float]] = {}
        for d in days:
            week_close[week_key(date.fromisoformat(d))] = by_day[d]   # last obs day in week wins
        weeks = sorted(set(wk) | set(week_close))
        weekly: List[Dict[str, Any]] = []
        prev_close: Optional[Tuple[str, float]] = None
        for w in weeks:
            row = {"week": w, "net": None, "gross": wk.get(w, {}).get("gross", 0.0),
                   "nBuckets": wk.get(w, {}).get("nBuckets", 0),
                   "partial": False, "coverage": None}
            cl = week_close.get(w)
            if cl and prev_close:
                if any(prev_close[0] < bt <= cl[0] for bt in break_ts):
                    row["net"] = None
                    row["partial"] = True
                else:
                    row["net"] = cl[1] - prev_close[1]
            if cl:
                prev_close = cl
            expected = max(1, len(grid) * 5)
            row["coverage"] = min(1.0, row["nBuckets"] / expected)
            if row["coverage"] < 0.8 or wk.get(w, {}).get("spanning", 0) > 0:
                row["partial"] = True
            weekly.append(row)

        out = {"version": self.store_version, "obs": obs, "grid": grid, "diffs": diffs,
               "daily": daily, "weekly": weekly, "breaks": breaks,
               "satAlarms": sum(1 for r in daily
                                if r["f"] is not None and r["state"] == "ok"
                                and date.fromisoformat(r["date"]).weekday() == 5
                                and abs(r["f"]) > 0.5)}
        self._derived[key] = out
        return out

    # weekly regime-scaled stats (spec §1.6 normalisation)
    @staticmethod
    def _scaled_weeks(weekly: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        rows = []
        for i, w in enumerate(weekly):
            gross_hist = [x["gross"] for x in weekly[max(0, i - 25):i + 1] if x["gross"] > 0]
            med26 = float(np.median(gross_hist)) if len(gross_hist) >= 8 else None
            s = (w["net"] / med26) if (w["net"] is not None and med26 and med26 > 0) else None
            rows.append({**w, "medGross26": med26, "s": s})
        for i, w in enumerate(rows):
            hist = [x["s"] for x in rows[max(0, i - 52):i] if x["s"] is not None and not x["partial"]]
            if w["s"] is not None and not w["partial"] and len(hist) >= 40:
                mu, sd = float(np.mean(hist)), float(np.std(hist, ddof=1))
                w["z1w"] = (w["s"] - mu) / sd if sd > 0 else None
            else:
                w["z1w"] = None
        return rows

    # ── meta envelope helper ─────────────────────────────────
    def _meta(self, pair: str, ck: str, label: Optional[str], n: int,
              rng: Optional[List[str]], flags: List[Dict[str, Any]]) -> Dict[str, Any]:
        return {"pair": pair, "clientType": label or ck, "clientTypeKey": ck,
                "effectiveRange": rng, "n": n, "storeVersion": self.store_version,
                "signConvention": self._cfg("sign_convention", "unconfirmed"),
                "sessionMapping": json.loads(self._cfg("session_offset") or "null"),
                "flags": flags}

    def _label(self, ck: str) -> Optional[str]:
        with self._conn() as c:
            r = c.execute("SELECT label FROM client_types WHERE ctype_key=?", (ck,)).fetchone()
        return r["label"] if r else None

    # ── status ───────────────────────────────────────────────
    def status(self) -> Dict[str, Any]:
        with self._conn() as c:
            uploads = [dict(r) for r in c.execute(
                "SELECT * FROM uploads ORDER BY id DESC LIMIT 40")]
            types = [{"key": r["ctype_key"], "label": r["label"],
                      "isAggregate": bool(r["is_aggregate"]), "firstSeen": r["first_seen"]}
                     for r in c.execute("SELECT * FROM client_types ORDER BY ctype_key")]
            cov_rows = c.execute(
                """SELECT pair, ctype_key, MIN(ts) a, MAX(ts) b, COUNT(*) n
                   FROM flows GROUP BY pair, ctype_key""").fetchall()
            breaks = [dict(r) for r in c.execute("SELECT * FROM level_breaks ORDER BY ts")]
        coverage: Dict[str, Dict[str, Any]] = {}
        for r in cov_rows:
            coverage.setdefault(r["pair"], {})[r["ctype_key"]] = {
                "from": r["a"], "to": r["b"], "nObs": r["n"],
                "label": next((t["label"] for t in types if t["key"] == r["ctype_key"]), r["ctype_key"])}
        # aggregation identity summary (per pair with aggregate + ≥1 segment)
        agg_res = {}
        for pair, cts in coverage.items():
            if "all client types" in cts and len(cts) > 1:
                res = self._agg_residual(pair)
                if res:
                    agg_res[pair] = res
        return {"gitSafety": self.git_safety(), "uploads": uploads, "coverage": coverage,
                "clientTypes": types, "levelBreaks": breaks, "aggResidual": agg_res,
                "signConvention": self._cfg("sign_convention", "unconfirmed"),
                "storeVersion": self.store_version}

    def _agg_residual(self, pair: str) -> Optional[Dict[str, Any]]:
        with self._conn() as c:
            cks = [r["ctype_key"] for r in c.execute(
                "SELECT DISTINCT ctype_key FROM flows WHERE pair=?", (pair,))]
        segs = [k for k in cks if k != "all client types"]
        if "all client types" not in cks or not segs:
            return None
        agg = {r["date"]: r["f"] for r in self.derived(pair, "all client types")["daily"]
               if r["f"] is not None and r["state"] == "ok"}
        seg_daily: Dict[str, float] = {}
        seg_ok: Dict[str, int] = {}
        for s in segs:
            for r in self.derived(pair, s)["daily"]:
                if r["f"] is not None and r["state"] == "ok":
                    seg_daily[r["date"]] = seg_daily.get(r["date"], 0.0) + r["f"]
                    seg_ok[r["date"]] = seg_ok.get(r["date"], 0) + 1
        common = [d for d in agg if seg_ok.get(d, 0) == len(segs)]
        if len(common) < 5:
            return None
        rhos = [agg[d] - seg_daily[d] for d in common]
        gross = [abs(agg[d]) for d in common]
        flagged = sum(1 for d, rho in zip(common, rhos)
                      if abs(rho) > max(0.5, 0.01 * abs(agg[d])))
        return {"medianAbs": float(np.median(np.abs(rhos))),
                "pctFlagged": round(100.0 * flagged / len(common), 1),
                "nDays": len(common), "dates": common[-260:],
                "rho": [round(r, 2) for r in rhos[-260:]]}

    def set_config(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        allowed = {"signConvention": "sign_convention", "sessionOffset": "session_offset",
                   "excludedHolidayDates": "excluded_holiday_dates",
                   "moyAnnotations": "moy_annotations"}
        for k, v in patch.items():
            if k not in allowed:
                raise ParseError(f"unknown config key {k}")
            if k == "signConvention" and v not in ("unconfirmed", "pos_buys_usd", "pos_sells_usd"):
                raise ParseError("signConvention must be unconfirmed|pos_buys_usd|pos_sells_usd")
            self._set_cfg(allowed[k], v if isinstance(v, str) else json.dumps(v))
        return self.get_config()

    def get_config(self) -> Dict[str, Any]:
        return {"signConvention": self._cfg("sign_convention", "unconfirmed"),
                "sessionOffset": json.loads(self._cfg("session_offset") or "null"),
                "excludedHolidayDates": json.loads(self._cfg("excluded_holiday_dates") or "[]"),
                "moyAnnotations": json.loads(self._cfg("moy_annotations") or "[]")}

    # ── analytics panels ─────────────────────────────────────
    def _pairs_types(self) -> List[Tuple[str, str]]:
        with self._conn() as c:
            return [(r["pair"], r["ctype_key"]) for r in
                    c.execute("SELECT DISTINCT pair, ctype_key FROM flows ORDER BY pair, ctype_key")]

    def panel_monitor(self) -> Dict[str, Any]:
        """B2 — weekly flow monitor across all pairs × segments."""
        rows: Dict[str, Dict[str, Any]] = {}
        for pair, ck in self._pairs_types():
            der = self.derived(pair, ck)
            weekly = self._scaled_weeks(der["weekly"])
            done = [w for w in weekly if w["net"] is not None]
            if not done:
                continue
            cur = done[-1]
            nets = [w["net"] for w in done]
            # 4w / 13w rolling sums + percentile of current 4w vs trailing 104 rolling 4w
            def rsum(k: int) -> Optional[float]:
                return float(np.sum(nets[-k:])) if len(nets) >= k else None
            pct4 = None
            if len(nets) >= 30:
                roll4 = [float(np.sum(nets[i - 4:i])) for i in range(4, len(nets) + 1)][-104:]
                if len(roll4) >= 26 and rsum(4) is not None:
                    pct4 = round(100.0 * float(np.mean([1 if rsum(4) >= x else 0 for x in roll4])))
            # streak with dead-band
            med_g = cur.get("medGross26")
            dead = 0.1 * med_g if med_g else None
            def wsign(w):
                if w["net"] is None or dead is None:
                    return 0
                return 0 if abs(w["net"]) < dead else (1 if w["net"] > 0 else -1)
            streak_len, streak_sign = 0, 0
            for w in reversed(done):
                s = wsign(w)
                if s == 0:
                    if streak_len:
                        break
                    continue
                if streak_sign == 0:
                    streak_sign = s
                if s != streak_sign:
                    break
                streak_len += 1
            completed: List[int] = []
            run, rs = 0, 0
            for w in done:
                s = wsign(w)
                if s == 0:
                    continue
                if s == rs:
                    run += 1
                else:
                    if run:
                        completed.append(run)
                    run, rs = 1, s
            pctile = (round(100.0 * float(np.mean([1 if streak_len >= x else 0 for x in completed])))
                      if len(completed) >= 20 else None)
            s4 = [w["s"] for w in done[-4:] if w["s"] is not None]
            s13 = [w["s"] for w in done[-13:] if w["s"] is not None]
            momentum = "flat"
            if len(s4) >= 3 and len(s13) >= 8:
                a4, a13 = float(np.mean(s4)), float(np.mean(s13))
                if abs(a4) > 1e-9 or abs(a13) > 1e-9:
                    if a4 * a13 < 0:
                        momentum = "reversing"
                    else:
                        momentum = "accelerating" if abs(a4) > abs(a13) else "decelerating"
            rows.setdefault(pair, {})[ck] = {
                "label": self._label(ck) or ck,
                "net1w": cur["net"], "wow": (cur["net"] - done[-2]["net"]) if len(done) > 1 and done[-2]["net"] is not None else None,
                "net4w": rsum(4), "net13w": rsum(13),
                "z1w": cur["z1w"], "pct4w": pct4, "nWeeks": len(done),
                "streak": {"len": streak_len, "sign": streak_sign,
                           "pctile": pctile, "nStreaks": len(completed),
                           "histMax": max(completed) if completed else None,
                           "deadBand": dead},
                "momentum": momentum, "partial": bool(cur["partial"]),
                "spark13w": [w["net"] for w in done[-13:]],
            }
        flags = [{"code": "REGIME_SCALED", "detail": "z on net/median26w(gross'); needs ≥40 weeks"}]
        return {"meta": self._meta("*", "*", "all", len(rows), None, flags),
                "data": {"rows": rows}}

    def panel_heatmap(self) -> Dict[str, Any]:
        """B4 — robust z of 1w/4w/13w regime-scaled sums vs trailing 2y."""
        cells = []
        for pair, ck in self._pairs_types():
            weekly = self._scaled_weeks(self.derived(pair, ck)["weekly"])
            svals = [w["s"] for w in weekly if w["s"] is not None and not w["partial"]]
            for hor, k in (("1w", 1), ("4w", 4), ("13w", 13)):
                cell = {"pair": pair, "clientType": self._label(ck) or ck, "ctypeKey": ck,
                        "horizon": hor, "z": None, "raw": None, "nWeeks": len(svals),
                        "reason": None}
                if len(svals) < 26 + k:
                    cell["reason"] = f"insufficient history (n={len(svals)}/{26 + k}w)"
                else:
                    roll = np.array([float(np.sum(svals[i - k:i])) for i in range(k, len(svals) + 1)])
                    hist = roll[-104:] if roll.size > 104 else roll
                    cell["z"] = _robust_z(float(roll[-1]), hist[:-1])
                    nets = [w["net"] for w in weekly if w["net"] is not None]
                    cell["raw"] = float(np.sum(nets[-k:])) if len(nets) >= k else None
                cells.append(cell)
        return {"meta": self._meta("*", "*", "all", len(cells), None,
                                   [{"code": "OVERLAPPING_HORIZONS",
                                     "detail": "1w/4w/13w share data — one story, not three confirmations"}]),
                "data": {"cells": cells}}

    def panel_anomaly(self) -> Dict[str, Any]:
        """B1 — chips: every (pair × type × 1w/4w) with robust |z| ≥ 2."""
        hm = self.panel_heatmap()["data"]["cells"]
        chips = sorted([c for c in hm if c["horizon"] in ("1w", "4w")
                        and c["z"] is not None and abs(c["z"]) >= 2],
                       key=lambda c: -abs(c["z"]))
        return {"meta": self._meta("*", "*", "all", len(chips), None, []),
                "data": {"chips": chips}}

    def panel_typicalweek(self, pair: str, ck: str,
                          exclude_holiday_weeks: bool = True) -> Dict[str, Any]:
        """B3 — current week cumulative path vs trailing-26w envelope."""
        der = self.derived(pair, ck)
        diffs = [d for d in der["diffs"] if d["flow"] is not None
                 and d["state"] in ("ok", "close", "overnight")]
        if not diffs:
            return {"meta": self._meta(pair, ck, self._label(ck), 0, None,
                                       [{"code": "INSUFFICIENT", "detail": "no usable buckets"}]),
                    "data": None}

        def week_key(dstr: str) -> str:
            d = date.fromisoformat(dstr)
            return (d + timedelta(days=(4 - d.weekday()) % 7)).isoformat()

        ccy = pair[3:] if _PAIR_RE.match(pair) else None
        by_week: Dict[str, List[Tuple[float, float]]] = {}
        for df in diffs:
            wkk = week_key(df["ts1"][:10])
            t1 = datetime.strptime(df["ts1"], ISO_FMT)
            fri = date.fromisoformat(wkk)
            pos = (t1 - datetime.combine(fri - timedelta(days=6), datetime.min.time())).total_seconds() / 3600.0
            by_week.setdefault(wkk, []).append((pos, df["flow"]))
        weeks = sorted(by_week)
        cur_w = weeks[-1]
        hist_w = weeks[:-1][-26:]
        excluded = []
        if exclude_holiday_weeks:
            keep = []
            for w in hist_w:
                fri = date.fromisoformat(w)
                days_in = [fri - timedelta(days=i) for i in range(0, 5)]
                us, loc = self._us(), self._local(ccy) if ccy else None
                hol = any((us is not None and d in us) or (loc is not None and d in loc)
                          for d in days_in)
                (excluded if hol else keep).append(w)
            hist_w = keep
        # envelope on a common hourly-position axis: cumulative at each position
        positions = sorted({p for w in hist_w + [cur_w] for p, _ in by_week[w]})
        env = {"pos": positions, "median": [], "p25": [], "p75": [], "p10": [], "p90": []}
        for p in positions:
            vals = []
            for w in hist_w:
                pts = sorted(by_week[w])
                cum = sum(f for pp, f in pts if pp <= p)
                if any(pp <= p for pp, _ in pts):
                    vals.append(cum)
            if len(vals) >= 8:
                q = np.percentile(vals, [10, 25, 50, 75, 90])
                env["p10"].append(float(q[0])); env["p25"].append(float(q[1]))
                env["median"].append(float(q[2])); env["p75"].append(float(q[3]))
                env["p90"].append(float(q[4]))
            else:
                for k in ("p10", "p25", "median", "p75", "p90"):
                    env[k].append(None)
        cur_pts = sorted(by_week[cur_w])
        cur_path = {"pos": [p for p, _ in cur_pts],
                    "cum": list(np.cumsum([f for _, f in cur_pts]))}
        biggest = sorted(by_week[cur_w], key=lambda t: -abs(t[1]))[:5]
        flags = [{"code": "HOLIDAY_WEEKS_EXCLUDED", "count": len(excluded)}] if excluded else []
        if len(hist_w) < 12:
            flags.append({"code": "INSUFFICIENT", "detail": f"envelope on {len(hist_w)} weeks (<12: wide)"})
        return {"meta": self._meta(pair, ck, self._label(ck), len(hist_w),
                                   [weeks[0], weeks[-1]], flags),
                "data": {"week": cur_w, "current": cur_path, "envelope": env,
                         "nEnvelopeWeeks": len(hist_w),
                         "largestPrints": [{"posHours": p, "flow": f} for p, f in biggest]}}

    def panel_tape(self, pair: str, ck: str, anchor_days: int = 183) -> Dict[str, Any]:
        """C1 — cumulative (rebased at anchor) + daily bars + spot overlay (degradable)."""
        der = self.derived(pair, ck)
        obs = der["obs"]
        if not obs:
            return {"meta": self._meta(pair, ck, self._label(ck), 0, None,
                                       [{"code": "INSUFFICIENT", "detail": "no data"}]),
                    "data": None}
        last_ts = datetime.strptime(obs[-1][0], ISO_FMT)
        anchor_iso = (last_ts - timedelta(days=anchor_days)).strftime(ISO_FMT)
        window = [(ts, v) for ts, v in obs if ts >= anchor_iso]
        base = window[0][1] if window else 0.0
        spot = {"available": False, "reason": "no spot fetcher configured", "dates": [], "mid": []}
        if self._spot_fetcher:
            try:
                spot = self._spot_fetcher(pair)
            except Exception as e:
                spot = {"available": False, "reason": f"spot fetch failed: {e}", "dates": [], "mid": []}
        daily = [r for r in der["daily"] if r["f"] is not None and r["date"] >= anchor_iso[:10]]
        flags = []
        gaps = sum(1 for r in daily if r["state"] == "gapSpanned")
        if gaps:
            flags.append({"code": "GAP_SPANNED", "count": gaps,
                          "detail": "drawn as single bars over their true span — never spread"})
        for b in der["breaks"]:
            flags.append({"code": "LEVEL_BREAK", "ts": b["ts"], "kind": b["kind"]})
        return {"meta": self._meta(pair, ck, self._label(ck), len(window),
                                   [obs[0][0], obs[-1][0]], flags),
                "data": {"anchor": anchor_iso,
                         "cum": {"ts": [ts for ts, _ in window],
                                 "value": [v - base for _, v in window],
                                 "breaks": der["breaks"]},
                         "daily": daily, "spot": spot,
                         "satAlarms": der["satAlarms"]}}

    def panel_positioning(self, pair: Optional[str], ck: str) -> Dict[str, Any]:
        """C2 — weekly-close range position R_W (26/52/104w); cross-pair strip when pair=None."""
        def series_R(p: str) -> Dict[str, Any]:
            der = self.derived(p, ck)
            weekly = der["weekly"]
            closes: List[Tuple[str, float]] = []
            by_day = {r["date"]: r["close"] for r in der["daily"]}
            for w in weekly:
                wk_days = [d for d in by_day if
                           (date.fromisoformat(d) + timedelta(days=(4 - date.fromisoformat(d).weekday()) % 7)).isoformat() == w["week"]]
                if wk_days:
                    closes.append((w["week"], by_day[max(wk_days)]))
            out = {"weeks": [w for w, _ in closes], "level": [v for _, v in closes], "R": {}}
            arr = np.array([v for _, v in closes], dtype=float)
            for label, W in (("26w", 26), ("52w", 52), ("104w", 104)):
                if arr.size >= W and arr.size >= int(0.8 * W):
                    win = arr[-W:]
                    lo, hi = float(np.min(win)), float(np.max(win))
                    out["R"][label] = round(100.0 * (arr[-1] - lo) / (hi - lo)) if hi > lo else None
                else:
                    out["R"][label] = None
            if arr.size >= 52:
                out["band52"] = {"min": float(np.min(arr[-52:])), "max": float(np.max(arr[-52:])),
                                 "q25": float(np.percentile(arr[-52:], 25)),
                                 "q75": float(np.percentile(arr[-52:], 75))}
            out["spark52"] = [v for _, v in closes[-52:]]
            out["nWeeks"] = len(closes)
            return out

        flags = [{"code": "RELATIVE_ONLY",
                  "detail": "positioning proxy since data start — one desk's book, relative only, never market positioning"}]
        if pair:
            s = series_R(pair)
            if s["nWeeks"] < 26:
                flags.append({"code": "INSUFFICIENT", "detail": f"n={s['nWeeks']}/26 weeks"})
            return {"meta": self._meta(pair, ck, self._label(ck), s["nWeeks"], None, flags),
                    "data": s}
        strip = []
        for p in sorted({pp for pp, k in self._pairs_types() if k == ck}):
            s = series_R(p)
            strip.append({"pair": p, "R52": s["R"].get("52w"), "spark52": s["spark52"],
                          "nWeeks": s["nWeeks"]})
        strip.sort(key=lambda r: -abs((r["R52"] or 50) - 50))
        return {"meta": self._meta("*", ck, self._label(ck), len(strip), None, flags),
                "data": {"strip": strip}}

    # ── seasonality panels ───────────────────────────────────
    def _daily_ok(self, pair: str, ck: str) -> List[Dict[str, Any]]:
        """Daily flows admitted to daily statistics: state ok (span 1 day) only."""
        return [r for r in self.derived(pair, ck)["daily"]
                if r["f"] is not None and r["state"] == "ok"]

    def panel_intraday(self, pair: str, ck: str, weeks: int = 26) -> Dict[str, Any]:
        """D1 — per-bucket profile: ok/close only + OVERNIGHT + CLOSE cells; block-bootstrap CI."""
        der = self.derived(pair, ck)
        grid = der["grid"]
        cutoff = None
        if der["obs"]:
            cutoff = (datetime.strptime(der["obs"][-1][0], ISO_FMT) - timedelta(weeks=weeks)).strftime(ISO_FMT)
        cells = {lab: {} for lab in grid}
        cells["OVERNIGHT"] = {}
        cells["CLOSE"] = {}
        sun_open: Dict[str, float] = {}
        excluded = 0
        for df in der["diffs"]:
            if df["flow"] is None or (cutoff and df["ts1"] < cutoff):
                continue
            d1 = date.fromisoformat(df["ts1"][:10])
            if d1.weekday() == 6 and df["ts1"][11:] != CLOSE_LABEL:
                sun_open[df["ts1"][:10]] = sun_open.get(df["ts1"][:10], 0.0) + df["flow"]
                continue
            if d1.weekday() >= 5:
                continue
            if df["state"] == "ok":
                cells[df["ts1"][11:]].setdefault(df["ts1"][:10], df["flow"])
            elif df["state"] == "close":
                cells["CLOSE"].setdefault(df["ts1"][:10], df["flow"])
            elif df["state"] == "overnight":
                cells["OVERNIGHT"].setdefault(df["ts1"][:10], df["flow"])
            elif df["state"] in ("gapSpanned", "offGrid"):
                excluded += 1
        out_cells = []
        kw_groups = []
        for lab in (["OVERNIGHT"] + grid + ["CLOSE"]):
            vals = np.array(list(cells.get(lab, {}).values()), dtype=float)
            n = vals.size
            cell = {"bucket": lab, "n": int(n), "mean": None, "median": None,
                    "trimmed": None, "iqr": None, "meanAbs": None, "ci": None}
            if n >= 60:
                cell["mean"] = float(np.mean(vals))
                cell["median"] = float(np.median(vals))
                k = max(1, int(0.05 * n))
                cell["trimmed"] = float(np.mean(np.sort(vals)[k:-k])) if n > 2 * k else cell["mean"]
                q = np.percentile(vals, [25, 75])
                cell["iqr"] = [float(q[0]), float(q[1])]
                cell["meanAbs"] = float(np.mean(np.abs(vals)))
                cell["ci"] = _boot_ci(vals)
                kw_groups.append(vals)
            out_cells.append(cell)
        kw_p = None
        if sps is not None and len(kw_groups) >= 3:
            try:
                kw_p = float(sps.kruskal(*kw_groups).pvalue)
            except Exception:
                kw_p = None
        best = max((c for c in out_cells if c["meanAbs"] is not None),
                   key=lambda c: c["meanAbs"], default=None)
        flags = [{"code": "GAP_SPANNED_EXCLUDED", "count": excluded},
                 {"code": "FILE_TIME", "detail": "buckets in file time — no session labels until mapping confirmed"}]
        median_buckets = float(np.median([r["nBuckets"] for r in der["daily"] if r["nBuckets"]])) if der["daily"] else 0
        if median_buckets < 3:
            flags.append({"code": "INSUFFICIENT",
                          "detail": f"insufficient intraday coverage (median n={median_buckets:.0f} buckets/day)"})
        sun = np.array(list(sun_open.values()), dtype=float)
        return {"meta": self._meta(pair, ck, self._label(ck),
                                   sum(c["n"] for c in out_cells), None, flags),
                "data": {"cells": out_cells, "kruskalP": kw_p,
                         "benchmarkCandidate": best["bucket"] if best else None,
                         "sunOpen": {"n": int(sun.size),
                                     "mean": float(np.mean(sun)) if sun.size >= 10 else None},
                         "windowWeeks": weeks}}

    def panel_dow(self, pair: str, ck: str, weeks: int = 52,
                  ex_month_end: bool = False, include_holidays: bool = False) -> Dict[str, Any]:
        """D2 — day-of-week profile with bootstrap CIs, hit rates, stability split, FDR flags."""
        ccy = pair[3:] if _PAIR_RE.match(pair) else None
        daily = self._daily_ok(pair, ck)
        if weeks and daily:
            cutoff = (date.fromisoformat(daily[-1]["date"]) - timedelta(weeks=weeks)).isoformat()
            daily = [r for r in daily if r["date"] >= cutoff]
        excluded_hol = 0
        rows_by_dow: Dict[int, List[float]] = {i: [] for i in range(7)}
        excl_cfg = set(json.loads(self._cfg("excluded_holiday_dates") or "[]"))
        for r in daily:
            d = date.fromisoformat(r["date"])
            if d.weekday() == 5:
                continue                        # Saturday: alarm-only, never a stat
            if not include_holidays and d.weekday() < 5:
                us, loc = self._us(), self._local(ccy) if ccy else None
                if ((us is not None and d in us) or (loc is not None and d in loc)) and r["date"] not in excl_cfg:
                    excluded_hol += 1
                    continue
            if ex_month_end and d.weekday() < 5:
                mb = self._month_bd_offset(d, ccy)
                if mb is not None and (mb <= 2 or mb >= -2):
                    if abs(mb) <= 2:
                        continue
            rows_by_dow[d.weekday()].append(r["f"])
        names = ["MON", "TUE", "WED", "THU", "FRI"]
        all_flows = np.array([f for i in range(5) for f in rows_by_dow[i]], dtype=float)
        out, pvals = [], []
        for i, nm in enumerate(names):
            vals = np.array(rows_by_dow[i], dtype=float)
            n = vals.size
            row = {"day": nm, "n": int(n), "mean": None, "ci": None, "median": None,
                   "hitRate": None, "hitCi": None, "meanAbs": None, "p": None}
            if n >= 60:
                row["mean"] = float(np.mean(vals))
                row["ci"] = _boot_ci(vals)
                row["median"] = float(np.median(vals))
                row["meanAbs"] = float(np.mean(np.abs(vals)))
                pos = int(np.sum(vals > 0))
                row["hitRate"] = pos / n
                if sps is not None:
                    lo, hi = sps.binomtest(pos, n).proportion_ci(confidence_level=0.90)
                    row["hitCi"] = [float(lo), float(hi)]
                    rest = np.array([f for j in range(5) if j != i for f in rows_by_dow[j]], dtype=float)
                    if rest.size >= 60:
                        row["p"] = float(sps.ttest_ind(vals, rest, equal_var=False).pvalue)
                        pvals.append(row["p"])
                # half-sample stability
                half = n // 2
                if half >= 30:
                    m1, m2 = float(np.mean(vals[:half])), float(np.mean(vals[half:]))
                    row["unstable"] = (m1 * m2 < 0) and (abs(row["mean"]) > 0)
            out.append(row)
        qmap = dict(zip([r["day"] for r in out if r["p"] is not None], _bh_fdr(pvals)))
        for r in out:
            r["q"] = qmap.get(r["day"])
            r["significant"] = r["q"] is not None and r["q"] <= 0.10
        sun = np.array(rows_by_dow[6], dtype=float)
        flags = [{"code": "HOLIDAYS_EXCLUDED", "count": excluded_hol,
                  "detail": "US+local holiday dates routed to the event-study panels"}]
        if ex_month_end:
            flags.append({"code": "EX_MONTH_END", "detail": "last/first 2 business days removed"})
        flags.append({"code": "FDR_SCOPE",
                      "detail": "BH-FDR across this pair's five weekday tests — cross-pair grid FDR runs in the heatmap"})
        return {"meta": self._meta(pair, ck, self._label(ck), int(all_flows.size), None, flags),
                "data": {"days": out,
                         "sunOpen": {"n": int(sun.size),
                                     "mean": float(np.mean(sun)) if sun.size >= 30 else None}}}

    def _month_bd_offset(self, d: date, ccy: Optional[str]) -> Optional[int]:
        """+1..+5 from month start, −5..−1 from month end (union good-day calendar),
        None = mid-month. Calendar-day alignment is deliberately not offered."""
        first = d.replace(day=1)
        last = (first + timedelta(days=45)).replace(day=1) - timedelta(days=1)
        fwd = [x for x in (first + timedelta(days=i) for i in range(0, 12))
               if x <= last and self._good_day(x, ccy)][:5]
        back = [x for x in (last - timedelta(days=i) for i in range(0, 12))
                if x >= first and self._good_day(x, ccy)][:5]
        if d in fwd:
            return fwd.index(d) + 1
        if d in back:
            return -(back.index(d) + 1)
        return None

    def panel_tom(self, pair: str, ck: str) -> Dict[str, Any]:
        """D3 — turn-of-month profile on the union US+local business-day grid."""
        ccy = pair[3:] if _PAIR_RE.match(pair) else None
        daily = self._daily_ok(pair, ck)
        buckets: Dict[str, List[Tuple[str, float]]] = {}
        for r in daily:
            d = date.fromisoformat(r["date"])
            if d.weekday() >= 5:
                continue
            off = self._month_bd_offset(d, ccy)
            key = ("mid" if off is None else (f"+{off}" if off > 0 else str(off)))
            buckets.setdefault(key, []).append((r["date"][:7], r["f"]))
        months = sorted({m for lst in buckets.values() for m, _ in lst})
        n_months = len(months)
        order = [f"+{i}" for i in range(1, 6)] + ["mid"] + [str(-i) for i in range(5, 0, -1)]
        out = []
        for key in order:
            lst = buckets.get(key, [])
            vals = np.array([f for _, f in lst], dtype=float)
            row = {"offset": key, "n": int(vals.size), "mean": None, "ci": None,
                   "median": None, "hitRate": None, "meanAbs": None}
            if n_months >= 18 and vals.size >= 12:
                row["mean"] = float(np.mean(vals))
                row["median"] = float(np.median(vals))
                row["meanAbs"] = float(np.mean(np.abs(vals)))
                row["hitRate"] = float(np.mean(vals > 0))
                # month-level bootstrap: resample months, mean of month-means
                mm: Dict[str, List[float]] = {}
                for m, f in lst:
                    mm.setdefault(m, []).append(f)
                month_means = np.array([float(np.mean(v)) for v in mm.values()])
                row["ci"] = _boot_ci(month_means)
            out.append(row)
        welch = None
        if sps is not None and n_months >= 24:
            pre = np.array([f for k in ("-1", "-2") for _, f in buckets.get(k, [])], dtype=float)
            mid = np.array([f for _, f in buckets.get("mid", [])], dtype=float)
            if pre.size >= 20 and mid.size >= 60:
                t = sps.ttest_ind(pre, mid, equal_var=False)
                welch = {"t": float(t.statistic), "p": float(t.pvalue),
                         "preMean": float(np.mean(pre)), "midMean": float(np.mean(mid))}
        flags = []
        if n_months < 18:
            flags.append({"code": "INSUFFICIENT", "detail": f"insufficient months (N={n_months}/18)"})
        elif n_months < 24:
            flags.append({"code": "WIDE_CI", "detail": f"N={n_months} months <24 — read CIs, not means"})
        flags.append({"code": "NO_FIX_LABELS", "detail": "no fixing-window labels until session mapping confirmed"})
        return {"meta": self._meta(pair, ck, self._label(ck), n_months, None, flags),
                "data": {"offsets": out, "welchPreVsMid": welch, "nMonths": n_months}}

    def panel_moy(self, pair: str, ck: str) -> Dict[str, Any]:
        """D4 — month-of-year strip: one dot per YEAR per month; no CI theatre at N≈3."""
        daily = self._daily_ok(pair, ck)
        per: Dict[Tuple[int, int], List[float]] = {}
        for r in daily:
            d = date.fromisoformat(r["date"])
            per.setdefault((d.year, d.month), []).append(r["f"])
        # a (year, month) counts as complete when it has ≥15 daily flows
        months_out = []
        kw_groups = []
        years_all = set()
        for m in range(1, 13):
            pts = []
            for (y, mm), vals in per.items():
                if mm == m and len(vals) >= 15:
                    pts.append({"year": y, "net": float(np.sum(vals)),
                                "gross": float(np.sum(np.abs(vals)))})
                    years_all.add(y)
            pts.sort(key=lambda p: p["year"])
            row = {"month": m, "years": pts,
                   "median": float(np.median([p["net"] for p in pts])) if len(pts) >= 3 else None,
                   "n": len(pts)}
            months_out.append(row)
            if len(pts) >= 3:
                kw_groups.append([p["net"] for p in pts])
        n_years = len(years_all)
        kw = None
        if n_years >= 8 and sps is not None and len(kw_groups) >= 6:
            try:
                kw = float(sps.kruskal(*kw_groups).pvalue)
            except Exception:
                kw = None
        flags = []
        if n_years < 8:
            flags.append({"code": "TEST_LOCKED", "detail": f"N={n_years} of 8 years — seasonality test locked"})
        annotations = json.loads(self._cfg("moy_annotations") or "[]")
        return {"meta": self._meta(pair, ck, self._label(ck), n_years, None, flags),
                "data": {"months": months_out, "kruskalP": kw, "nYears": n_years,
                         "annotations": annotations}}

    # ── holiday event studies (E1/E2 share this engine) ──────
    def _holiday_events(self, ccy: Optional[str], which: str) -> Tuple[List[date], List[str]]:
        """Event dates (first closed day of a bridge) for 'us' or 'local', full obs span."""
        cal = self._us() if which == "us" else (self._local(ccy) if ccy else None)
        if cal is None:
            return [], []
        excl = set(json.loads(self._cfg("excluded_holiday_dates") or "[]"))
        other = self._local(ccy) if which == "us" else self._us()
        events, names = [], []
        return events, names  # populated by caller via span

    def panel_holiday(self, pair: str, ck: str, which: str) -> Dict[str, Any]:
        ccy = pair[3:] if _PAIR_RE.match(pair) else None
        cal = self._us() if which == "us" else (self._local(ccy) if ccy else None)
        label = self._label(ck)
        if cal is None:
            reason = (f"no local calendar for {ccy}" if which == "local"
                      else "holidays package unavailable")
            return {"meta": self._meta(pair, ck, label, 0, None,
                                       [{"code": "NO_CALENDAR", "detail": reason}]),
                    "data": None}
        daily = self._daily_ok(pair, ck)
        if len(daily) < 120:
            return {"meta": self._meta(pair, ck, label, len(daily), None,
                                       [{"code": "INSUFFICIENT", "detail": f"n={len(daily)}/120 daily flows"}]),
                    "data": None}
        flow_by_date = {r["date"]: r["f"] for r in daily}
        d0, d1 = date.fromisoformat(daily[0]["date"]), date.fromisoformat(daily[-1]["date"])
        excl = set(json.loads(self._cfg("excluded_holiday_dates") or "[]"))
        other = self._local(ccy) if which == "us" else self._us()

        # events: weekday holidays in span; bridges pooled at first closed day; overlaps split out
        events: List[Dict[str, Any]] = []
        d = d0
        prev_holiday = False
        while d <= d1:
            is_hol = d.weekday() < 5 and d in cal and d.isoformat() not in excl
            if is_hol and not prev_holiday:
                overlap = other is not None and d in other
                nxt = d + timedelta(days=1)
                multi = False
                while nxt.weekday() < 5 and nxt in cal:
                    multi = True
                    nxt += timedelta(days=1)
                events.append({"date": d, "name": str(cal.get(d)), "overlap": overlap,
                               "bridge": multi,
                               "longWeekend": d.weekday() in (0, 4)})
            prev_holiday = d.weekday() < 5 and d in cal
            d += timedelta(days=1)
        pure = [e for e in events if not e["overlap"]]
        overlap_n = len(events) - len(pure)

        # offset dates in union-calendar business days
        def bd_offset(ev: date, off: int) -> Optional[date]:
            d, step, k = ev, (1 if off > 0 else -1), abs(off)
            while k > 0:
                d += timedelta(days=step)
                if d < d0 - timedelta(days=10) or d > d1 + timedelta(days=10):
                    return None
                if self._good_day(d, ccy):
                    k -= 1
            return d

        offsets = [-3, -2, -1, 1]
        # weekday-matched baseline: non-event-window days by weekday
        window_dates = set()
        for e in events:
            for off in offsets:
                bd = bd_offset(e["date"], off)
                if bd:
                    window_dates.add(bd.isoformat())
            window_dates.add(e["date"].isoformat())
        base_by_dow: Dict[int, List[float]] = {i: [] for i in range(5)}
        for ds, f in flow_by_date.items():
            dd = date.fromisoformat(ds)
            if dd.weekday() < 5 and ds not in window_dates and self._good_day(dd, ccy):
                base_by_dow[dd.weekday()].append(f)

        grid_cells = []
        pvals = []
        for off in offsets:
            for subset, subname in ((pure, "all"),):
                ev_flows, base_pool = [], []
                for e in subset:
                    bd = bd_offset(e["date"], off)
                    if bd and bd.isoformat() in flow_by_date:
                        ev_flows.append(flow_by_date[bd.isoformat()])
                        base_pool.extend(base_by_dow[bd.weekday()])
                ev = np.array(ev_flows, dtype=float)
                base = np.array(base_pool, dtype=float)
                cell = {"offset": off, "nEvents": int(ev.size), "deltaUsdM": None,
                        "ci": None, "welchP": None, "rankP": None, "q": None,
                        "deltaSd": None, "grossRatio": None}
                if ev.size >= 10 and base.size >= 60:
                    delta = float(np.mean(ev) - np.mean(base))
                    cell["deltaUsdM"] = delta
                    sd = float(np.std(base, ddof=1))
                    cell["deltaSd"] = delta / sd if sd > 0 else None
                    boot = _boot_ci(ev)
                    if boot:
                        cell["ci"] = [boot[0] - float(np.mean(base)), boot[1] - float(np.mean(base))]
                    if sps is not None:
                        cell["welchP"] = float(sps.ttest_ind(ev, base, equal_var=False).pvalue)
                        cell["rankP"] = float(sps.mannwhitneyu(ev, base, alternative="two-sided").pvalue)
                        pvals.append((cell, cell["welchP"]))
                    all_abs = np.abs(np.array(list(flow_by_date.values())))
                    cell["grossRatio"] = (float(np.mean(np.abs(ev)) / np.mean(all_abs))
                                          if all_abs.size and np.mean(all_abs) > 0 else None)
                grid_cells.append(cell)
        qv = _bh_fdr([p for _, p in pvals])
        for (cell, _), q in zip(pvals, qv):
            cell["q"] = q
        upcoming = []
        d = date.today()
        while len(upcoming) < 4 and d < date.today() + timedelta(days=400):
            if d.weekday() < 5 and d in cal:
                bd_count = sum(1 for i in range(1, (d - date.today()).days + 1)
                               if self._good_day(date.today() + timedelta(days=i), ccy)
                               and date.today() + timedelta(days=i) < d)
                upcoming.append({"date": d.isoformat(), "name": str(cal.get(d)),
                                 "bizDaysAway": bd_count})
            d += timedelta(days=1)
        flags = [{"code": "FDR_SCOPE", "detail": "BH q across this pair×type×offset grid; raw p also shown"},
                 {"code": "WEEKDAY_MATCHED", "detail": "baseline = non-event days of the same weekday"},
                 {"code": "GAP_SPANNED_EXCLUDED",
                  "detail": "spanned flows never enter event cells — a spanned pre-holiday flow would fabricate the signal"}]
        if overlap_n:
            flags.append({"code": "OVERLAP_SPLIT",
                          "detail": f"{overlap_n} US∩local overlap events kept out of this grid (own bucket)"})
        tz_note = "holiday-proximity aligns on the file-time DATE — can be off by one day if the desk timezone differs from the holiday country"
        flags.append({"code": "TZ_CAVEAT", "detail": tz_note})
        return {"meta": self._meta(pair, ck, label, len(pure),
                                   [daily[0]["date"], daily[-1]["date"]], flags),
                "data": {"holidayType": which, "grid": grid_cells,
                         "nEvents": len(pure), "nOverlap": overlap_n,
                         "holidayList": [{"date": e["date"].isoformat(), "name": e["name"],
                                          "bridge": e["bridge"], "longWeekend": e["longWeekend"]}
                                         for e in pure][-40:],
                         "upcoming": upcoming}}

    # ── spot fetcher wiring ──────────────────────────────────
    def set_spot_fetcher(self, fn: Callable[[str], Dict[str, Any]]) -> None:
        self._spot_fetcher = fn


# ─────────────────────────────────────────────────────────────
# Self-test: python3 client_flow_service.py   (synthetic data only)
# ─────────────────────────────────────────────────────────────
def _selftest() -> None:            # pragma: no cover
    import tempfile
    ok = True

    def chk(name, cond):
        nonlocal ok
        ok = ok and bool(cond)
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")

    tmp = tempfile.mkdtemp()
    svc = ClientFlowService(db_path=os.path.join(tmp, "t.db"), check_git=False)

    # synthetic export: 3h grid, 2 client types + aggregate, ~90 weekdays, cumulative walk
    rng = np.random.default_rng(7)
    lines = ["Pair\tView Type\tcumUSD\tType\tTime\tCummulative USD (mio)"]
    labels = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "23:59"]
    cum = {"All Client Types": 0.0, "Real Money": 0.0, "Hedge Funds": 0.0}
    d = date(2025, 1, 6)
    for _ in range(130):
        if d.weekday() < 5:
            for lab in labels:
                for ct in cum:
                    step = float(rng.normal(0, 5)) if lab != "23:59" else 0.0
                    if ct == "All Client Types":
                        pass
                    else:
                        cum[ct] += step
                cum["All Client Types"] = cum["Real Money"] + cum["Hedge Funds"]
                for ct in cum:
                    v = f"{cum[ct]:.1f}"
                    lines.append(f"USDTWD\t{ct}\t{v}\t{ct}\t{d.strftime('%d/%m/%Y')} {lab}\t{v}")
        d += timedelta(days=1)
    # inject QC rows: blank value, ######## time, conflicting dup columns
    lines.append("USDTWD\tReal Money\t\tReal Money\t03/03/2025 09:00\t")
    lines.append("USDTWD\tReal Money\t5.0\tReal Money\t########\t5.0")
    lines.append("USDTWD\tReal Money\t7.0\tReal Money\t04/03/2025 09:00\t9.9")
    data = "\n".join(lines).encode()

    pv = svc.preview(data, "synthetic.tsv")
    chk("preview verdict clean", pv["verdict"] == "clean")
    chk("blank counted", pv["blankCells"] == 1)
    chk("hash counted (hand-copied hint)", pv["hashCells"] == 1 and pv["handCopiedHint"])
    chk("column conflict quarantined", pv["colConflicts"] == 1)
    res = svc.commit(pv["sha"])
    chk("commit bumps version", res["storeVersion"] == 1)

    der = svc.derived("USDTWD", "real money")
    chk("grid inferred (8 buckets)", len(der["grid"]) == 8)
    ok_states = {x["state"] for x in der["diffs"]}
    chk("states assigned", "ok" in ok_states and "close" in ok_states)
    daily = [r for r in der["daily"] if r["f"] is not None]
    chk("daily flows present", len(daily) > 80)
    # Σ(intraday cells incl. OVERNIGHT+CLOSE) ≡ F_d on a clean weekday
    mid = daily[len(daily) // 2]
    parts = [x["flow"] for x in der["diffs"]
             if x["ts1"][:10] == mid["date"] and x["state"] in ("ok", "close", "overnight")]
    chk("bucket-sum reconciles to daily F", abs(sum(parts) - mid["f"]) < 1e-6)

    mon = svc.panel_monitor()["data"]["rows"]
    chk("monitor rows", "USDTWD" in mon and "real money" in mon["USDTWD"])
    intr = svc.panel_intraday("USDTWD", "real money", weeks=26)["data"]
    chk("intraday cells populated", any(c["mean"] is not None for c in intr["cells"]))
    dow = svc.panel_dow("USDTWD", "real money")["data"]
    chk("dow rows", len(dow["days"]) == 5)
    tom = svc.panel_tom("USDTWD", "real money")
    chk("tom insufficient flagged at ~4 months",
        any(f["code"] == "INSUFFICIENT" for f in tom["meta"]["flags"]))
    hol = svc.panel_holiday("USDTWD", "real money", "us")
    chk("holiday panel returns (data or honest insufficiency)",
        hol["data"] is not None or any(f["code"] in ("INSUFFICIENT", "NO_CALENDAR")
                                       for f in hol["meta"]["flags"]))
    resid = svc._agg_residual("USDTWD")
    chk("aggregation identity ~0 on synthetic", resid is not None and resid["medianAbs"] < 0.2)

    # restatement + rebase detection on a partial re-upload
    lines2 = ["Pair\tView Type\tcumUSD\tType\tTime\tCummulative USD (mio)"]
    for ln in lines[1:200]:
        parts_ = ln.split("\t")
        try:
            v = float(parts_[2]) + 100.0     # constant offset → rebase
            parts_[2] = parts_[5] = f"{v:.1f}"
        except ValueError:
            continue
        lines2.append("\t".join(parts_))
    pv2 = svc.preview("\n".join(lines2).encode(), "reup.tsv")
    chk("rebase detected on constant offset", pv2["verdict"] == "rebase")

    # duplicate upload short-circuit
    pv3 = svc.preview(data, "same.tsv")
    chk("duplicate detected", pv3["verdict"] == "duplicate")

    # git safety canary decision table (filesystem walk works without git on PATH)
    chk("canary: temp dir has no enclosing repo", _find_repo_root(tmp) is None)
    chk("canary: backend dir is inside the checkout here", _find_repo_root(_DIR) is not None)
    real = ClientFlowService(db_path=os.path.join(tmp, "canary.db"), check_git=True)
    gs = real.git_safety()
    chk("canary: OK on this checkout (ignored + untracked)", gs.get("ok") is True)

    # revert restores
    before = svc.derived("USDTWD", "real money")["obs"][:5]
    r2 = svc.commit(svc.preview("\n".join(lines2).encode(), "reup2.tsv")["sha"])
    svc.revert(r2["uploadId"])
    after = svc.derived("USDTWD", "real money")["obs"][:5]
    chk("revert restores values", all(abs(a[1] - b[1]) < 1e-9 for a, b in zip(before, after)))

    print("ALL PASS" if ok else "FAILURES ABOVE")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":          # pragma: no cover
    logging.basicConfig(level="WARNING")
    _selftest()
