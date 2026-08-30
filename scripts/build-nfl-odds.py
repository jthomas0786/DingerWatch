#!/usr/bin/env python3
"""
build-nfl-odds.py — deterministic builder for slates/nfl-odds.json.

Reads a raw bundle of OpticOdds /fixtures/odds responses (saved by the cron
agent) and produces the app-consumed odds file keyed by `matchKey` (away-home
in ESPN abbreviations, so it joins to slates/nfl.json by team pair).

It does NOT call OpticOdds. It owns: market mapping, best-price selection,
over/under shape, WSH->WAS / LAR->LA team normalization, no-NaN validation,
and a wipe-guard that refuses to overwrite good odds with a smaller/empty build
(protects against transient connector or API failures during preseason).

Usage:  python3 scripts/build-nfl-odds.py <raw-bundle.json> [repo-root]
"""
import json, os, sys, datetime

MARKET_MAP = {
    "anytime_touchdown_scorer": "atd",
    "player_rushing_yards": "rushYds",
    "player_receiving_yards": "recYds",
    "player_receptions": "receptions",
    "player_passing_touchdowns": "passTds",
}
CORE5 = ["atd", "rushYds", "recYds", "receptions", "passTds"]

# OpticOdds -> ESPN team abbreviation normalization (the only mismatches).
ABBR_NORM = {"WSH": "WAS", "LAR": "LA"}


def norm_abbr(a):
    return ABBR_NORM.get(a, a)


def norm_name(s):
    import re
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\b", "", str(s or "").lower().replace(".", ""))
    return re.sub(r"\s+", " ", s).strip()


def best(all_entries):
    if not all_entries:
        return None
    b = max(all_entries, key=lambda e: e["price"])
    return {"book": b["book"], "price": b["price"], "link": b["link"]}


def abbr(competitors):
    return (competitors or [{}])[0].get("abbreviation") if competitors else None


def name_of(competitors):
    return (competitors or [{}])[0].get("name") if competitors else None


def main():
    if len(sys.argv) < 2:
        print("ERROR: missing raw-bundle path", file=sys.stderr)
        sys.exit(2)
    raw_path = sys.argv[1]
    repo = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    out_path = os.path.join(repo, "slates", "nfl-odds.json")

    with open(raw_path) as f:
        bundle = json.load(f)

    # Flatten all odds responses; dedupe fixtures across market calls by id.
    fixtures = {}
    for resp in bundle.get("oddsResponses", []):
        rows = resp if isinstance(resp, list) else resp.get("data", [])
        for fx in rows:
            fid = fx.get("id")
            if not fid:
                continue
            rec = fixtures.setdefault(fid, {
                "fixtureId": fid, "away": norm_abbr(abbr(fx.get("away_competitors"))),
                "home": norm_abbr(abbr(fx.get("home_competitors"))),
                "awayName": name_of(fx.get("away_competitors")),
                "homeName": name_of(fx.get("home_competitors")),
                "seasonWeek": fx.get("season_week"), "seasonType": fx.get("season_type"),
                "startDateUTC": fx.get("start_date"), "status": fx.get("status"),
                "venue": fx.get("venue_name"), "_players": {},
            })
            for o in fx.get("odds", []):
                mk = o.get("market_id")
                if mk not in MARKET_MAP:
                    continue
                pk = MARKET_MAP[mk]
                sel = o.get("selection") or o.get("name")
                p = rec["_players"].setdefault(sel, {"name": sel, "playerId": o.get("player_id"),
                                                     "team": o.get("team_id"), "odds": {}})
                e = {"book": o.get("sportsbook"), "price": o.get("price"),
                     "link": (o.get("deep_link") or {}).get("desktop"), "ts": o.get("timestamp")}
                if pk == "atd":
                    p["odds"].setdefault("atd", {"all": []})["all"].append(e)
                else:
                    slot = p["odds"].setdefault(pk, {"line": o.get("points"),
                                                    "over": {"all": []}, "under": {"all": []}})
                    slot["over" if o.get("selection_line") == "over" else "under"]["all"].append(e)

    games = []
    for fid, g in fixtures.items():
        players = []
        for sel, p in g["_players"].items():
            oo = {}
            for pk, slot in p["odds"].items():
                if pk == "atd":
                    b = best(slot["all"])
                    if b:
                        oo["atd"] = {"best": b, "all": slot["all"]}
                else:
                    ov = best(slot["over"]["all"]); un = best(slot["under"]["all"])
                    if ov or un:
                        oo[pk] = {"line": slot["line"],
                                  "over": {"best": ov, "all": slot["over"]["all"]} if ov else None,
                                  "under": {"best": un, "all": slot["under"]["all"]} if un else None}
            if oo:
                players.append({"name": p["name"], "playerId": p["playerId"], "team": p["team"], "odds": oo})
        if not players:
            continue
        g.pop("_players")
        g["matchKey"] = f"{g['away']}-{g['home']}"
        g["markets"] = sorted([k for k in CORE5 if any(k in p["odds"] for p in players)])
        g["players"] = players
        games.append(g)

    games.sort(key=lambda g: (g.get("startDateUTC") or "", g["matchKey"]))

    # Wipe-guard: never replace good odds with a smaller/empty build.
    existing_games = 0
    if os.path.exists(out_path):
        try:
            existing_games = len(json.load(open(out_path)).get("games", []))
        except Exception:
            existing_games = 0
    if existing_games and len(games) < existing_games:
        print(f"SKIP wipe-guard: new {len(games)} < existing {existing_games}; keeping current file.")
        sys.exit(0)

    result = {
        "meta": {
            "source": "opticodds",
            "books": sorted({e["book"] for g in games for p in g["players"]
                             for pk in p["odds"].values() for e in (pk.get("all") or [])}),
            "markets": CORE5,
            "fetchedAt": bundle.get("generatedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sample": False,
            "note": "Live NFL player props (OpticOdds). Joined to slates/nfl.json by matchKey + player name.",
        },
        "games": games,
    }

    # Validate: no NaN / non-finite prices, all links present.
    s = json.dumps(result)
    if "NaN" in s or "Infinity" in s:
        print("ERROR: NaN/Infinity in output — refusing to write.", file=sys.stderr)
        sys.exit(1)
    for g in games:
        for p in g["players"]:
            for pk, slot in p["odds"].items():
                b = slot.get("best") if pk == "atd" else (slot.get("over", {}) or {}).get("best")
                if b and not (b.get("link") and isinstance(b.get("price"), (int, float))):
                    print(f"WARN: incomplete entry for {p['name']} {pk}", file=sys.stderr)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"WROTE {out_path}: {len(games)} games, "
          f"{sum(len(g['players']) for g in games)} players, markets={sorted({m for g in games for m in g['markets']})}")


if __name__ == "__main__":
    main()
