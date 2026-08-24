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
    write_json(CACHE_PATH, data)


def fetch_leaderboard(season):
    """
    Pull the season-long Statcast expected-stats leaderboard for all qualified
    hitters in one shot. Keyed by MLBAM player id, which matches the ids already
    in slate.json from the MLB Stats API — so the join is exact, not name-based.
    (Name matching would break on accents, Jr./Sr., and duplicate names.)
    """
    from pybaseball import (
        statcast_batter_expected_stats,
        statcast_batter_exitvelo_barrels,
        statcast_batter_percentile_ranks,
    )

    log(f"fetching {season} expected-stats leaderboard…")
    xstats = statcast_batter_expected_stats(season, minPA=50)

    # Sprint speed is its own Savant leaderboard, not a percentile or contact
    # metric. It can still be useful for a low-contact runner, so retain rows
    # that appear only here instead of requiring an expected-stats match.
    log(f"fetching {season} sprint-speed leaderboard…")
    try:
        from pybaseball import statcast_sprint_speed
        sprint = statcast_sprint_speed(season, min_opp=10)
    except Exception as e:
        log(f"WARNING: sprint-speed leaderboard unavailable ({e}) — continuing without sprint speed")
        sprint = None

    # IMPORTANT: barrel rate / exit velo / hard-hit% come from the exitvelo_barrels
    # leaderboard, which holds ACTUAL RATES. Do NOT source them from
    # statcast_batter_percentile_ranks — every column in that table is a
    # percentile (0-100), so a 90th-percentile hitter would surface as a
    # "90% barrel rate" instead of his real ~13%.
    log(f"fetching {season} exit velocity & barrels (actual rates)…")
    try:
        ev = statcast_batter_exitvelo_barrels(season, minBBE=50)
    except Exception as e:
        log(f"exitvelo/barrels unavailable ({e}) — continuing without contact-quality metrics")
        ev = None

    # Percentiles are still useful for UI context bars, but are stored under
    # explicitly *Pctile keys so they can never be mistaken for a rate.
    log(f"fetching {season} percentile ranks (for context bars only)…")
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

    # `sprint_speed` is feet per second. Do not add a null placeholder when
    # Savant omits a player: absent means no qualifying running data, not zero.
    if sprint is not None:
        for _, row in sprint.iterrows():
            pid = int(row.get("player_id", 0) or 0)
            speed = _f(row.get("sprint_speed"))
            if not pid or speed is None:
                continue
            out.setdefault(str(pid), {})["sprintSpeed"] = round(speed, 1)

    # --- actual contact-quality rates ---
    if ev is not None:
        for _, row in ev.iterrows():
            pid = str(int(row.get("player_id", 0) or 0))
            if pid not in out:
                continue
            out[pid].update({
                "barrelPct":  _rate(row, ["brl_percent", "barrel_batted_rate"], 0, 35),
                "exitVelo":   _rate(row, ["avg_hit_speed", "exit_velocity_avg"], 60, 100),
                "hardHitPct": _rate(row, ["ev95percent", "hard_hit_percent"], 0, 80),
                "maxExitVelo":_rate(row, ["max_hit_speed"], 80, 130),
                "bbe":        _f(row.get("attempts")),
            })

    # --- percentiles, namespaced so they can't be confused with rates ---
    if pct is not None:
        for _, row in pct.iterrows():
            pid = str(int(row.get("player_id", 0) or 0))
            if pid in out:
                out[pid].update({
                    "barrelPctile":  _pctile(row.get("brl_percent")),
                    "exitVeloPctile": _pctile(row.get("exit_velocity_avg")),
                    "xwobaPctile":   _pctile(row.get("xwoba")),
                })

    _validate(out)

    log(f"{len(out)} hitters in leaderboard")
    return out


def _clean(v):
    """
    pandas uses NaN/NaT for missing values, and json.dump writes those as bare
    `NaN` / `Infinity` — which are NOT valid JSON, so anything downstream
    (Node, browsers, jq) fails to parse the whole file. Convert to None here.
    """
    if v is None:
        return None
    # NaN is the only value that isn't equal to itself.
    if isinstance(v, float) and v != v:
        return None
    if isinstance(v, float) and (v == float("inf") or v == float("-inf")):
        return None
    # numpy / pandas scalar types -> native Python
    if hasattr(v, "item"):
        try:
            v = v.item()
        except (ValueError, AttributeError):
            return None
        if isinstance(v, float) and v != v:
            return None
    # pandas NaT and similar sentinels stringify to 'NaT'/'nan'
    if isinstance(v, str) and v in ("nan", "NaN", "NaT", "<NA>"):
        return None
    return v


def sanitize(obj):
    """Recursively strip NaN/Inf from a nested structure before serialising."""
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    return _clean(obj)


def write_json(path, payload):
    """
    Single place that writes JSON. allow_nan=False makes an escaped NaN raise
    loudly here instead of silently producing a file that fails to parse in CI.
    """
    cleaned = sanitize(payload)
    with open(path, "w") as f:
        json.dump(cleaned, f, indent=2, allow_nan=False)


def _f(v):
    try:
        if v is None or v != v:  # NaN check
            return None
        return round(float(v), 3)
    except (TypeError, ValueError):
        return None


def _rate(row, candidate_cols, lo, hi):
    """
    Pull the first present column from candidates and range-check it.

    The range check is the guard that would have caught the percentile-vs-rate
    bug immediately: a barrel rate of 90 fails `0 <= v <= 35` and gets rejected
    rather than silently rendering as "90% barrel rate".
    """
    for col in candidate_cols:
        if col not in row:
            continue
        v = _f(row.get(col))
        if v is None:
            continue
        if lo <= v <= hi:
            return v
        log(f"  ! {col}={v} outside plausible range [{lo}, {hi}] — rejected "
            f"(are you reading a percentile table by mistake?)")
        return None
    return None


def _pctile(v):
    """Percentiles must be 0-100; anything else is the wrong column."""
    v = _f(v)
    if v is None:
        return None
    return v if 0 <= v <= 100 else None


def _validate(board):
    """Sanity-check the assembled board and shout if the distribution is wrong."""
    barrels = [m["barrelPct"] for m in board.values() if m.get("barrelPct") is not None]
    if not barrels:
        log("WARNING: no barrel rates present — frontend will fall back to derived estimates")
        return
    avg = sum(barrels) / len(barrels)
    mx = max(barrels)
    log(f"barrel% sanity: n={len(barrels)} avg={avg:.1f} max={mx:.1f}")
    # League-average barrel rate sits around 7-9%; a max near 20% is elite.
    if avg > 20 or mx > 35:
        log("WARNING: barrel rates look like PERCENTILES, not rates. "
            "Check the source leaderboard columns before publishing.")


# wOBA linear weights for non-batted-ball PA outcomes. Statcast's own xwOBA uses
# fixed linear weights for walks / HBP / Ks, so a windowed xwOBA computed the
# same way stays on the same scale as the season leaderboard value (which is
# PA-weighted) rather than drifting high like a batted-ball-only mean would.
_WOBA_BB = 0.69
_WOBA_HBP = 0.72

# PA outcomes that do NOT count as an at-bat. xSLG is per-AB, so these are excluded
# from its denominator entirely (not counted as 0) — matching the season est_slg.
# sac_fly is a batted ball but does NOT count as an at-bat, so it is excluded from
# both the xSLG numerator and denominator, just as Savant's season est_slg is.
_NON_AB_EVENTS = {
    "walk", "intent_walk", "hit_by_pitch", "sac_bunt", "sac_fly",
    "sac_fly_double_play", "sac_bunt_double_play",
    "batter_interference", "catcher_interf", "balk",
}


def compute_windowed_statcast(df, n_games, min_bbe, min_pa, min_ab):
    """
    Aggregate Statcast over a hitter's last n game-dates from a raw
    statcast_batter dataframe (the same 45-day pull fetch_batter_detail already
    makes, so this adds no extra API calls).

    Windows are defined by the last n unique game-dates where the hitter had a
    plate appearance (not only dates with a batted ball), so a hot streak is
    not missed because its batted balls happened to fall on fewer dates.

    Barrel %, Exit Velo, Hard-Hit % and Launch Angle are batted-ball aggregates
    gated by a minimum BBE so tiny windows don't surface as nonsense. xwOBA is
    PA-weighted (batted balls use estimated_woba_using_speedangle; walks/HBP/Ks
    use fixed linear weights) and xSLG is AB-weighted — both matching how Savant
    computes the season values, so the season tier thresholds stay valid.

    Returns None when there is no usable recent sample; the frontend then falls
    back to the season value for that metric.
    """
    import pandas as pd

    pa_rows = df[df["events"].notna()].copy()
    if pa_rows.empty:
        return None
    pa_rows["game_date"] = pd.to_datetime(pa_rows["game_date"], errors="coerce").dt.date
    pa_rows = pa_rows[pa_rows["game_date"].notna()]
    dates = sorted(pa_rows["game_date"].unique(), reverse=True)[:n_games]
    if not dates:
        return None
    w = pa_rows[pa_rows["game_date"].isin(dates)]
    pa = int(len(w))
    bbe_df = w[w["launch_speed"].notna()]
    bbe = int(len(bbe_df))

    out = {"pa": pa, "bbe": bbe}

    # --- batted-ball rate metrics (require a minimum sample of batted balls) ---
    if bbe >= min_bbe:
        # The raw Statcast CSV has no `barrel` column; a batted ball is a barrel
        # when its launch_speed_angle bucket == 6 (the "ideal contact" zone).
        if "launch_speed_angle" in bbe_df.columns:
            lsa = pd.to_numeric(bbe_df["launch_speed_angle"], errors="coerce")
            barrels = int((lsa == 6).sum())
            out["barrelPct"] = round(100 * barrels / bbe, 1)
        elif "barrel" in bbe_df.columns:  # fallback for exports that include it
            barrels = int((bbe_df["barrel"] == 1).sum())
            out["barrelPct"] = round(100 * barrels / bbe, 1)
        out["exitVelo"] = round(float(bbe_df["launch_speed"].mean()), 1)
        out["hardHitPct"] = round(100 * int((bbe_df["launch_speed"] >= 95).sum()) / bbe, 1)
        if "launch_angle" in bbe_df.columns:
            la = bbe_df[bbe_df["launch_angle"].notna()]
            if len(la) >= min_bbe:
                out["launchAngle"] = round(float(la["launch_angle"].mean()), 1)

    # --- PA-weighted xwOBA (consistent with the season leaderboard value) ---
    # Batted balls use Savant's estimated_woba_using_speedangle; walks/HBP use
    # fixed linear weights; strikeouts and other outs contribute 0. If the est
    # column is absent, or too many BIP lack an estimate, omit the metric so the
    # frontend falls back to season rather than understating with silent zeros.
    if pa >= min_pa and "estimated_woba_using_speedangle" in w.columns:
        bip = w[w["launch_speed"].notna()]
        missing_est = int((bip["estimated_woba_using_speedangle"].isna()).sum())
        tol = max(1, int(0.25 * len(bip))) if len(bip) else 0
        if missing_est <= tol:
            num = 0.0
            for _, r in w.iterrows():
                ev = r.get("events")
                if pd.notna(r.get("launch_speed")):
                    est = r.get("estimated_woba_using_speedangle")
                    num += float(est) if pd.notna(est) else 0.0
                elif ev in ("walk", "intent_walk"):
                    num += _WOBA_BB
                elif ev == "hit_by_pitch":
                    num += _WOBA_HBP
                # strikeouts and other outs contribute 0
            out["xwoba"] = round(num / pa, 3)

    # --- AB-weighted xSLG (consistent with the season est_slg) ---
    # AB excludes walks/HBP/sacrifices/interference. BIP use
    # estimated_slg_using_speedangle; non-BIP AB outcomes (strikeouts, field
    # outs) contribute 0. Omit if the est column is absent or too many BIP lack one.
    ab_rows = w[~w["events"].isin(_NON_AB_EVENTS)]
    ab = int(len(ab_rows))
    if ab >= min_ab and "estimated_slg_using_speedangle" in ab_rows.columns:
        bip = ab_rows[ab_rows["launch_speed"].notna()]
        ests = bip["estimated_slg_using_speedangle"]
        missing_est = int((ests.isna()).sum())
        tol = max(1, int(0.25 * len(bip))) if len(bip) else 0
        if missing_est <= tol:
            num = float(ests[ests.notna()].sum())
            out["xslg"] = round(num / ab, 3)

    return out


def fetch_batter_detail(player_ids, season, days=45):
    """
    Per-hitter Statcast detail that only exists in the raw pitch-level data:
      * zone grid   — performance by strike-zone location (the heat map)
      * pitch types — how he handles FF / SL / CH / CU etc.
      * batted balls— recent EV/LA points, split by pitcher handedness

    This is the expensive call (one raw pull per hitter), so it's limited to a
    recent window and run only for hitters actually on tonight's slate.
    """
    from pybaseball import statcast_batter
    from datetime import date, timedelta

    end = date.today()
    start = end - timedelta(days=days)
    out = {}

    for n, pid in enumerate(player_ids, 1):
        if n % 25 == 0:
            log(f"  batter detail {n}/{len(player_ids)}")
        try:
            df = statcast_batter(start.isoformat(), end.isoformat(), pid)
        except Exception as e:
            continue
        if df is None or df.empty:
            continue

        bb = df[df["launch_speed"].notna()]

        # --- zone grid: Statcast zones 1-9 are the strike zone, 11-14 are chase
        zones = {}
        for z, grp in df[df["zone"].notna()].groupby("zone"):
            hits = grp["events"].isin(["single", "double", "triple", "home_run"]).sum()
            abs_ = grp["events"].notna().sum()
            zbb = grp[grp["launch_speed"].notna()]
            zones[int(z)] = {
                "pitches": int(len(grp)),
                "swings": int(grp["description"].str.contains("swing|foul|hit_into_play", case=False, na=False).sum()),
                "hits": int(hits),
                "abs": int(abs_),
                "avg": round(hits / abs_, 3) if abs_ >= 3 else None,
                "ev": round(float(zbb["launch_speed"].mean()), 1) if len(zbb) >= 3 else None,
                "hr": int((grp["events"] == "home_run").sum()),
            }

        # --- performance by pitch type
        pitches = {}
        for pt, grp in df[df["pitch_type"].notna()].groupby("pitch_type"):
            pbb = grp[grp["launch_speed"].notna()]
            abs_ = grp["events"].notna().sum()
            hits = grp["events"].isin(["single", "double", "triple", "home_run"]).sum()
            whiffs = grp["description"].isin(["swinging_strike", "swinging_strike_blocked"]).sum()
            swings = grp["description"].str.contains("swing|foul|hit_into_play", case=False, na=False).sum()
            pitches[str(pt)] = {
                "seen": int(len(grp)),
                "abs": int(abs_),
                "avg": round(hits / abs_, 3) if abs_ >= 5 else None,
                "ev": round(float(pbb["launch_speed"].mean()), 1) if len(pbb) >= 3 else None,
                "la": round(float(pbb["launch_angle"].mean()), 1) if len(pbb) >= 3 else None,
                "hr": int((grp["events"] == "home_run").sum()),
                "whiffPct": round(100 * whiffs / swings, 1) if swings >= 5 else None,
            }

        # --- recent batted balls, tagged by the pitcher's handedness
        points = []
        for _, r in bb.tail(60).iterrows():
            # Every field goes through _clean: `events` is NaN on any pitch that
            # didn't end the at-bat, which was writing a literal NaN into the JSON.
            la = _clean(r.get("launch_angle"))
            dist = _clean(r.get("hit_distance_sc"))
            date = _clean(r.get("game_date"))
            points.append({
                "ev": round(float(r["launch_speed"]), 1),
                "la": round(float(la), 1) if la is not None else None,
                "dist": int(dist) if dist is not None else None,
                "hand": _clean(r.get("p_throws")),
                "result": _clean(r.get("events")),
                "date": str(date)[:10] if date is not None else None,
            })

        out[str(pid)] = {
            "windowDays": days,
            "zones": zones,
            "pitchTypes": pitches,
            "battedBalls": points,
            "statcastL5": compute_windowed_statcast(df, 5,  min_bbe=3, min_pa=8,  min_ab=6),
            "statcastL10": compute_windowed_statcast(df, 10, min_bbe=5, min_pa=15, min_ab=12),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slate", default="public/slate.json")
    ap.add_argument("--max-cache-age", type=int, default=2,
                    help="days before the cached leaderboard is considered stale")
    ap.add_argument("--detail-days", type=int, default=45,
                    help="lookback window for per-hitter zone/pitch-type data")
    ap.add_argument("--skip-detail", action="store_true",
                    help="skip the slow per-hitter pitch-level pull")
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
                write_json(args.slate, slate)
                return 0  # non-fatal by design
            log("falling back to stale cache")
            slate.setdefault("warnings", []).append(
                "Statcast metrics served from a stale cache")

    # ---- per-hitter detail (zone grid, pitch types, batted balls) ----
    slate_ids = []
    for game in slate["games"]:
        for side in ("away", "home"):
            for h in game[side].get("lineup", []):
                slate_ids.append(h["id"])
    slate_ids = list(dict.fromkeys(slate_ids))

    detail = {}
    if not args.skip_detail:
        log(f"fetching pitch-level detail for {len(slate_ids)} hitters (this is the slow part)…")
        try:
            detail = fetch_batter_detail(slate_ids, season, days=args.detail_days)
            log(f"detail retrieved for {len(detail)} hitters")
        except Exception as e:
            log(f"batter detail failed ({e}) — zone/pitch-type charts will be unavailable")
            slate.setdefault("warnings", []).append("Statcast pitch-level detail unavailable")

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
                d = detail.get(str(hitter["id"]))
                if d:
                    # Windowed Statcast lives as a top-level sibling, not nested
                    # inside `detail`, so the frontend reads h.statcastL5/L10
                    # directly and the detail payload stays lean.
                    sl5 = d.pop("statcastL5", None)
                    sl10 = d.pop("statcastL10", None)
                    hitter["detail"] = d
                    if sl5:
                        hitter["statcastL5"] = sl5
                    if sl10:
                        hitter["statcastL10"] = sl10

    slate["sources"]["statcast"] = f"Baseball Savant via pybaseball ({season})"
    slate["statcastEnrichedAt"] = datetime.utcnow().isoformat() + "Z"
    log(f"matched {matched} hitters, {missing} without Statcast data (usually low-PA callups)")

    # Round-trip check: parse what we're about to write with the same strictness
    # Node will use, so a malformed file fails here rather than in CI.
    try:
        json.loads(json.dumps(sanitize(slate), allow_nan=False))
    except (ValueError, TypeError) as e:
        log(f"ABORT: produced invalid JSON ({e}) — leaving the existing slate untouched")
        return 1

    write_json(args.slate, slate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
