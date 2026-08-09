#!/usr/bin/env python3
"""
enrich-statcast.py — layers Statcast contact-quality metrics onto slate.json

This is deliberately a SEPARATE, OPTIONAL step from build-slate.js because it's
the one fragile piece of the pipeline: pybaseball scrapes Baseball Savant rather
than using a supported API, so it can break when Savant changes their pages.

Design consequence: if this fails, the slate is still complete and usable — it
just won't have barrel%/exit-velo. The CI step is marked continue-on-error for
exactly this reason. Don't let a scraper outage take down the whole site.

Caching: Savant's leaderboard covers all qualified hitters in one request, so we
pull it once and join locally rather than hitting them per-player. We also cache
to disk, so a scrape failure falls back to the last good pull instead of blanking
out every metric.

Usage:
    python enrich-statcast.py --slate public/slate.json
    python enrich-statcast.py --slate public/slate.json --max-cache-age 3
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

CACHE_PATH = ".cache/statcast-leaderboard.json"


def log(msg):
    print(f"  [statcast] {msg}", flush=True)


def load_cache(max_age_days):
    """Return cached leaderboard if it exists and is fresh enough."""
    if not os.path.exists(CACHE_PATH):
        return None
    age = datetime.now() - datetime.fromtimestamp(os.path.getmtime(CACHE_PATH))
    if age > timedelta(days=max_age_days):
        log(f"cache is {age.days}d old (max {max_age_days}d) — will refetch")
        return None
    with open(CACHE_PATH) as f:
        log(f"using cache ({age.days}d old)")
        return json.load(f)


def save_cache(data):
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    with open(CACHE_PATH, "w") as f:
        json.dump(data, f)


def fetch_leaderboard(season):
    """
    Pull the season-long Statcast expected-stats leaderboard for all qualified
    hitters in one shot. Keyed by MLBAM player id, which matches the ids already
    in slate.json from the MLB Stats API — so the join is exact, not name-based.
    (Name matching would break on accents, Jr./Sr., and duplicate names.)
    """
    from pybaseball import statcast_batter_expected_stats, statcast_batter_percentile_ranks

    log(f"fetching {season} expected-stats leaderboard…")
    xstats = statcast_batter_expected_stats(season, minPA=50)

    log(f"fetching {season} percentile ranks…")
    try:
        pct = statcast_batter_percentile_ranks(season)
    except Exception as e:
        log(f"percentile ranks unavailable ({e}) — continuing without them")
        pct = None

    out = {}
    for _, row in xstats.iterrows():
        pid = int(row.get("player_id", 0) or 0)
        if not pid:
            continue
        out[str(pid)] = {
            "pa": _f(row.get("pa")),
            "avg": _f(row.get("ba")),
            "xba": _f(row.get("est_ba")),
            "slg": _f(row.get("slg")),
            "xslg": _f(row.get("est_slg")),
            "woba": _f(row.get("woba")),
            "xwoba": _f(row.get("est_woba")),
        }

    if pct is not None:
        for _, row in pct.iterrows():
            pid = str(int(row.get("player_id", 0) or 0))
            if pid in out:
                out[pid].update({
                    "barrelPct": _f(row.get("brl_percent")),
                    "exitVelo": _f(row.get("exit_velocity_avg")),
                    "hardHitPct": _f(row.get("hard_hit_percent")),
                    "barrelPctile": _f(row.get("brl_percent_percentile")),
                    "exitVeloPctile": _f(row.get("exit_velocity_avg_percentile")),
                    "xwobaPctile": _f(row.get("xwoba_percentile")),
                })

    log(f"{len(out)} hitters in leaderboard")
    return out


def _f(v):
    try:
        if v is None or v != v:  # NaN check
            return None
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slate", default="public/slate.json")
    ap.add_argument("--max-cache-age", type=int, default=2,
                    help="days before the cached leaderboard is considered stale")
    args = ap.parse_args()

    with open(args.slate) as f:
        slate = json.load(f)

    season = int(slate["date"][:4])

    board = load_cache(args.max_cache_age)
    if board is None:
        try:
            board = fetch_leaderboard(season)
            save_cache(board)
        except Exception as e:
            log(f"FETCH FAILED: {e}")
            board = load_cache(max_age_days=999)  # any cache beats nothing
            if board is None:
                log("no cache available — leaving slate without Statcast metrics")
                slate.setdefault("warnings", []).append(
                    "Statcast enrichment unavailable (scrape failed, no cache)")
                slate["sources"]["statcast"] = "UNAVAILABLE — scrape failed"
                with open(args.slate, "w") as f:
                    json.dump(slate, f, indent=2)
                return 0  # non-fatal by design
            log("falling back to stale cache")
            slate.setdefault("warnings", []).append(
                "Statcast metrics served from a stale cache")

    matched = missing = 0
    for game in slate["games"]:
        for side in ("away", "home"):
            for hitter in game[side].get("lineup", []):
                m = board.get(str(hitter["id"]))
                if m:
                    hitter["statcast"] = m
                    matched += 1
                else:
                    hitter["statcast"] = None
                    missing += 1

    slate["sources"]["statcast"] = f"Baseball Savant via pybaseball ({season})"
    slate["statcastEnrichedAt"] = datetime.utcnow().isoformat() + "Z"
    log(f"matched {matched} hitters, {missing} without Statcast data (usually low-PA callups)")

    with open(args.slate, "w") as f:
        json.dump(slate, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
