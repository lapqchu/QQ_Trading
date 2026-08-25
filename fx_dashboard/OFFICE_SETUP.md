# Running the dashboard on a restricted (corporate) network

On some networks Python cannot open direct HTTPS connections to the external
statistics hosts (tablebuilder.singstat.gov.sg, data.gov.sg, fao.org, spgroup.com.sg)
even though the browser reaches them fine — the browser uses the network's web proxy
(PAC file), Python doesn't. LSEG data always works (it rides the Workspace desktop
session).

The dashboard handles this with **three layers, tried in this order**:

```
1. LIVE FETCH        — direct, or through the network proxy via EXT_DATA_PROXY
2. SNAPSHOT CACHE    — backend/.fund_cache/*.json, synced through this git repo
3. LSEG ALTERNATIVES — where a real LSEG-carried series exists (e.g. COE PQP)
```

Nothing is ever proxied or fabricated: when a layer fails, panels either show the
snapshot **with an amber stale badge showing its age**, fall back to a clearly
**relabelled** LSEG series, or say "unavailable" outright.

---

## Layer 1 — route fetches through the network proxy (`EXT_DATA_PROXY`)

> This does NOT bypass the firewall — it routes traffic through the same monitored
> proxy the browser uses. If the proxy's policy blocked these sites, this would fail
> too. If you are unsure whether command-line tools may use the proxy at your
> workplace, ask IT first. Skip this layer entirely and rely on layers 2–3 if in doubt.

**Find the proxy address (Windows):**
1. Settings → Network & Internet → Proxy.
   - If "Manual proxy setup" is on → the address:port shown is what you need.
   - If "Use setup script" shows a PAC URL → open that URL in the browser; in the
     script, look for lines like `PROXY proxy.example.net:8080` — that's the address.
2. Or in a terminal: `netsh winhttp show proxy`.
3. Or ask IT for "the HTTP proxy address for command-line tools".

**Set it before starting the backend:**

```powershell
# PowerShell, this session only:
$env:EXT_DATA_PROXY = "http://proxy.example.net:8080"
python app.py

# or persist it for future terminals:
setx EXT_DATA_PROXY "http://proxy.example.net:8080"
```

**Verify:** open SG FUNDAMENTALS → MONITOR, press REFRESH. If the amber
`stale:` list next to the build stamp clears and the contributions/COE/rents
panels fill, the proxy path works.

**Known limitation:** proxies requiring NTLM/Kerberos authentication won't accept a
plain proxy URL — the fetches will still fail. That's fine: layers 2–3 take over.

---

## Layer 2 — snapshot sync through git

`backend/.fund_cache/` (committed in this repo) holds every external fetch as plain
JSON of public official statistics, stamped with its fetch time. On a machine that
can't fetch, the backend serves this snapshot automatically and the UI shows the
amber stale badge with its age. A per-host circuit breaker skips unreachable hosts
for 10 minutes at a time, so blocked networks stay fast.

**Workflow:**
- At home: use the dashboard normally (it refreshes the cache as it runs), then
  `git add fx_dashboard/backend/.fund_cache && git commit -m "data snapshot" && git push`.
- At the office: `git pull`. Done — no settings needed.

**How often to push?** Driven by the release calendar, not by the tool:

| Source                         | Updates            | Practical sync need   |
|--------------------------------|--------------------|-----------------------|
| CPI components / core groups   | monthly (~23rd)    | after each CPI print  |
| COE bidding results            | 2×/month (bid Wed) | monthly is fine; mid-month if you want fresh COE |
| FAO food index                 | monthly (~4th)     | rides the same push   |
| URA / HDB rents                | quarterly          | rides the same push   |
| SP tariff                      | quarterly          | rides the same push   |

**≈ one push per month (after the CPI print) keeps the office fully current;
two if you want fresh COE mid-month.** Any commit you make while developing carries
the cache along anyway. Staler is never wrong — just amber-badged with its age.

Note on `vintages.json`: both machines may write it (it records pre-release
consensus/nowcast vintages for the surprise scorecard — LSEG polls work at the
office, so the office records too). If a pull ever conflicts on it, keep either
side; missing entries re-record on the next build before each release.

---

## Layer 3 — LSEG-carried alternatives

Where LSEG carries a genuinely equivalent official series, the panel falls back to
it with an explicit relabel (never silently):

- **COE**: LSEG PQP (`aSGMVBPQPAC/BC`) — the official Prevailing Quota Premium, a
  smoothed monthly average, shown when per-exercise bidding results are unreachable.
  *(built)*
- **Division-level CPI contributions** and **M2 Phillips core off `aSGCPICOR`** —
  planned; needs RIC verification in a live Workspace session before wiring
  (no guessed RICs, per the house rule). Until then, M1 and the 14-component
  contributions need layer 1 or 2.

## Request-limit sanity

External sources are free public APIs with generous limits (SingStat ~100
calls/min; data.gov.sg ~3/10s) and the dashboard makes ~7 external calls per
6-hour build — negligible. The LSEG side is unchanged by any of this and stays
well inside the daily request budget (monitor ~dozens of history calls/day;
the carry β pull is ~42 histories at most once per 2h, on demand).
