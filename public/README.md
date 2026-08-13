# Dinger Watch — Slate Builder

Rebuilds the daily MLB slate server-side so the frontend makes **one same-origin
request** instead of ~50 cross-origin ones.

## Why this exists

The single-file HTML version fetched everything from the browser. Two problems:

1. **Blocked when published** — cross-origin `fetch()` to MLB/Open-Meteo gets
   blocked by CSP on most static hosts, so live data silently failed.
2. **Stale hardcoded stats** — HR totals, rosters, and trades were transcribed by
   hand, so they drifted out of date and had to be manually corrected.

Moving the fetching server-side fixes both. Every stat that was previously
hand-typed is now pulled fresh each morning from the MLB Stats API.

## Files

| File | Purpose |
|---|---|
| `build-slate.js` | Main builder. Schedule → rosters → stats → weather → `slate.json` |
| `parks.json` | Static park factors + field orientation. Update ~yearly |
| `enrich-statcast.py` | Optional Statcast layer. Fragile by nature — allowed to fail |
| `daily-slate.yml` | GitHub Actions workflow → `.github/workflows/` |

## Quick start

```bash
node build-slate.js                      # today → public/slate.json
node build-slate.js --date 2026-08-10    # a specific date
node build-slate.js --out data/x.json    # custom path
```

No dependencies — uses Node 18+ built-in `fetch`.

Optional Statcast layer:
```bash
pip install pybaseball pandas
python enrich-statcast.py --slate public/slate.json
```

## Deploying on GitHub Pages

1. Copy `daily-slate.yml` → `.github/workflows/daily-slate.yml`
2. Settings → Pages → deploy from branch, folder `/public`
3. Settings → Actions → General → Workflow permissions → **Read and write**
4. Point the frontend at `./slate.json` (same origin — no CORS)

Trigger a manual build anytime from the Actions tab.

## What's automatic vs. maintained

**Automatic, self-correcting daily:**
schedule · start times · probable pitchers · active rosters · injuries (via
active-vs-40-man diff) · trades · HR/AVG/OPS · K/9, HR/9, ERA, WHIP · last-10
game logs · weather + wind-relative-to-park

**You maintain:**
- `parks.json` — park factors drift slowly; refresh each preseason
- Statcast scraper — may need a fix if Savant changes their pages

**Still not solved:**
- **Sportsbook odds.** No free public feed exists. The-Odds-API is ~$30/mo for
  real FanDuel lines. Until you add that, keep any odds in the UI clearly
  labeled as estimates rather than real market prices.

## Background push notifications (app closed)

In-page alerts need the tab open. For notifications with everything closed you
need **Web Push**, which is three parts:

| Part | Where it lives |
|---|---|
| Service worker (receives the push) | `public/sw.js` |
| Subscription store | `public/push-subscriptions.json` |
| Sender (polls MLB, sends pushes) | GitHub Actions |

### Design note

Pushes are sent **bare** — no payload. Encrypting a Web Push payload needs
aes128gcm + ECDH, a lot of hand-rolled crypto that fails in subtle ways. A bare
push only needs a VAPID JWT signature. The service worker treats it as a wake-up
call and fetches `latest-hr.json` for the details, so what it displays is
current at display time rather than whenever the message was queued.

### Setup

```bash
node gen-vapid-keys.js
```

1. Paste the **public** key into `index.html` as `VAPID_PUBLIC_KEY`
2. Add repo secrets `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`
3. Create `public/push-subscriptions.json` containing `[]`
4. Copy `push.yml` to `.github/workflows/`
5. Open the app → **Alerts** → copy the subscription JSON it shows → add it to
   `push-subscriptions.json` and commit

Step 5 is manual because GitHub Pages serves static files only — there is no
endpoint to POST a subscription to. For a handful of devices this is fine. To
automate it, host a tiny function (Cloudflare Workers/Vercel free tier) that
accepts the POST and appends to the file.

### Constraints worth knowing

- **iOS 16.4+ only, and only for installed apps.** Add to Home Screen first.
- **GitHub Actions cron is best-effort** and often runs late under load, so a
  5-minute schedule can drift. Alerts may lag the actual home run by minutes.
- Expired subscriptions (404/410) are pruned automatically.
- Cold start records the day's backlog without pushing, so enabling mid-slate
  doesn't blast every homer at once.

## One-tap betslips

`fetch-odds.js` attaches real prices and sportsbook deep links to slate.json,
so tapping **Place bet** opens the wager already loaded — no copy/paste, no bot.

### Setup

1. Get a key at [the-odds-api.com](https://the-odds-api.com) (free tier available)
2. Add repo secret `ODDS_API_KEY`
3. The daily workflow runs it automatically after build-slate.js

```bash
node fetch-odds.js --slate public/slate.json     # all configured books
node fetch-odds.js --books fanduel               # single book
node fetch-odds.js --markets batter_home_runs    # single market, cheapest
node fetch-odds.js --dry-run                     # verify name matching first
```

### How the links work

The API returns a deep link per outcome:

```
https://sportsbook.fanduel.com/addToBetslip?marketId=42.448600011&selectionId=29165
```

Sportsbooks accept one selection per URL, so a parlay opens a tab per leg — they
accumulate in the same betslip because the book tracks slip state per session.
A single-leg pick is genuinely one tap.

### Cost

Player-prop markets bill **per event per market**. A 15-game slate across six
prop markets is roughly 90 credits per run. The free tier is 500/month, so run
once daily and trim `--markets` if you need to stretch it.

### When a prop has no line

Bench players and late callups often aren't priced. Those legs show "no line" in
the slip and are skipped on placement rather than silently dropped.

## Troubleshooting

### Wrong or tiny slate?

```bash
node diagnose.js            # what the API returns for today ± 1 day
node build-slate.js --verbose
```

`diagnose.js` prints the UTC date, the US Eastern date, and the schedule for
three consecutive days, so a date-offset problem is immediately visible.

Common causes:

| Symptom | Cause |
|---|---|
| All games `Final` | Built for a past date — check the Eastern vs UTC date |
| Only 2-4 games | Either a genuine light slate (All-Star break, early April) or the wrong date |
| Mock `Player 6xxxxx` names | `slate.example.json` got copied to `slate.json` — delete and rebuild |
| 0 games | Off-day, or the API returned a different date bucket (logged as a warning) |

### Barrel rates look absurd (60-95%)

Real barrel rates are **4-16%**. If you see values near 90, the enrichment step
read a *percentile* column instead of a *rate* column.

`statcast_batter_percentile_ranks` returns percentiles (0-100) in **every**
column — `brl_percent` there is the percentile of barrel rate, not the rate.
Actual rates come from `statcast_batter_exitvelo_barrels`.

Both layers now guard against this:

- `enrich-statcast.py` range-checks each metric and logs a warning if the
  distribution looks like percentiles
- the frontend rejects out-of-range values and falls back to derived estimates,
  logging to the browser console

So a repeat of this bug degrades to slightly-wrong numbers rather than absurd ones.

**Date handling:** MLB game dates follow US convention — a 10pm ET game belongs to
that calendar day, not the next UTC day. The builder anchors to US Eastern for
exactly this reason. Using the UTC date would build tomorrow's slate for any run
after ~8pm ET.

## Failure behavior

Designed to degrade, not collapse:

- Per-request retry with exponential backoff
- One team's roster failing doesn't kill the build — it's recorded in `warnings[]`
- Build failure exits non-zero, but the previously committed `slate.json` stays
  live, so the site serves yesterday's data rather than nothing
- Statcast is `continue-on-error` and falls back to a disk cache

Always check `slate.warnings` — that's where partial failures surface.

## Output shape

```jsonc
{
  "date": "2026-08-09",
  "generatedAt": "2026-08-09T10:00:03Z",
  "gameCount": 15,
  "sources": { /* provenance for every field */ },
  "warnings": [ /* partial failures */ ],
  "games": [{
    "gamePk": 776543,
    "startTimeUTC": "2026-08-09T17:35:00Z",
    "status": "Preview",
    "venue": { "name": "Wrigley Field", "parkFactor": 102, "cfBearing": 34, "roof": "open-air" },
    "weather": {
      "tempF": 81, "windMph": 12, "windDeg": 190, "dewPoint": 64, "precipChance": 10,
      "wind": { "label": "Out to left field", "sector": "out", "relativeDeg": -24 }
    },
    "away": {
      "abbr": "CHC",
      "pitcher": { "id": 663, "name": "…", "stats": { "k9": 10.4, "hr9": 1.1, "era": 3.42 } },
      "lineup": [{
        "id": 12345, "name": "…", "pos": "RF",
        "season": { "hr": 24, "avg": 0.281, "ops": 0.842, "pa": 480 },
        "last10": { "ab": 38, "h": 12, "hr": 3, "avg": 0.316 },
        "gameLog": [ /* per-game rows for the sparkline */ ],
        "statcast": { "barrelPct": 12.4, "exitVelo": 91.8, "xwoba": 0.371 }
      }]
    },
    "home": { /* same shape */ }
  }]
}
```

## Frontend

`mlb-hr-dashboard-v5.html` is already wired to this. It fetches `./slate.json`
once on load and derives every tab from it.

Deploy layout:

```
public/
  index.html      ← mlb-hr-dashboard-v5.html, renamed
  slate.json      ← written by the workflow
```

Test locally (file:// blocks fetch, so use a server):

```bash
node build-slate.js --out public/slate.json
cd public && python3 -m http.server 8000   # → localhost:8000
```

Live in-game state (score/inning/count) still polls the MLB API directly from the
browser, since a daily build can't cover in-progress games. If that's blocked on
your host, proxy it via a serverless function and point `fetchLiveGameStates()`
at your own endpoint.

### What the adapter derives

The builder emits raw stats; the frontend adapter maps them to its scoring model:

| Frontend field | Derived from |
|---|---|
| `statcast.barrel/ev/hardHit` | real Statcast if enriched, else ISO-based estimate (flagged `_derived`) |
| `speed` | SB ÷ times-on-base, adjusted by position |
| `recentForm.trend` | last-10 AVG vs season AVG (±45 pts) |
| `tier` | HR pace projected to 550 PA |
| `weatherEffect` | wind sector from the builder (out/in/across) |

Players whose Statcast is derived rather than measured are labeled in the UI, so
estimated numbers are never presented as measured ones.

## Scheduling note

GitHub cron is UTC and doesn't shift for daylight saving. `0 10 * * *` is 6am ET
in summer, 5am ET in winter. Both land before first pitch, so it doesn't matter
here — but worth knowing if you tighten the timing.
