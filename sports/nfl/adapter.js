// sports/nfl/adapter.js — Touchdown Watch NFL adapter (Phase 1 MVP, ATD-only).
//
// Data sources:
//   - Schedule/teams/venue: ESPN hidden API (site.api.espn.com), no key, verified
//     reachable from cloud + GitHub Actions. CC-BY-NC 4.0 (ESPN) — attribution.
//   - Players + stats: nflverse 2025 regular-season data (roster + snap counts +
//     play-by-play), CC-BY 4.0 (attribution: nflverse). The roster is the player
//     master (gsis_id / pfr_id / espn_id / full_name / headshot); snap counts are
//     joined by pfr_id and PBP by gsis_id. 2025 is the Week-1 baseline.
//
// Model: self-contained regressed-touchdown-rate ATD model (scoreAtdPlayer). It is
// intentionally NOT wired through model-engine-vm.js (which is still MLB-coupled);
// it is config-driven so it can move into the shared engine later.
//
//   node build-slate.js --sport nfl                         # current week
//   node build-slate.js --sport nfl --week 1 --seasontype 2 # a specific week
//
// Odds / inactives are optional + fail-soft in this MVP (see config.availability).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname as pathDirname } from 'node:path';
import { loadOrBuildStatsCache } from './stats.js';
import { loadOrBuildRoster2026Cache, blendRosters } from './roster2026.js';
import { canonTeam, TEAM_ALIASES, CANON_TEAMS } from './teams.js';
import { fetchAvailability, lookupAvailability } from './availability.js';

const UA = 'okhttp/4.12.0'; // ESPN allowlists known HTTP-library UAs (curl, okhttp, Python-urllib) and 403s browser/custom UAs.
const CACHE_PATH = '/tmp/nfl_stats_2025_v2.json';
const ROSTER_CACHE_PATH = '/tmp/nfl_roster_2026.json';
const HERE = fileURLToPath(new URL('./', import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SEASON = arg('--season', '2026');
const SEASON_TYPE = arg('--seasontype'); // 1=pre 2=reg 3=post, or null=current
const WEEK = arg('--week');              // or null=current
// Default output lives at the site root (GitHub Pages serves this repo directly,
// so `slates/nfl.json` is fetchable as `./slates/nfl.json` from index.html).
const OUT = arg('--out', 'slates/nfl.json');
const VERBOSE = process.argv.includes('--verbose');
const SKIP_AVAIL = process.argv.includes('--no-availability');

async function fetchJSON(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const TYPE_SHORT = { '1': 'pre', '2': 'reg', '3': 'post' };
function slateId(season, typeShort, week) {
  return `${season}-${typeShort}-w${String(week).padStart(2, '0')}`;
}

function gradeFor(prob, grades) {
  for (const g of grades) if (prob >= g.min) return { grade: g.grade, label: g.label };
  return { grade: 'F', label: 'Avoid' };
}

/**
 * Self-contained ATD model: regressed touchdown rate.
 * Returns probability + grade. QB passing TDs are not credited to the QB — the
 * PBP td_player_id is always the scorer (runner/receiver) — so QB ATD here is
 * rushing TDs only, which is correct.
 */
/**
 * Score one player's anytime-touchdown probability.
 * @param p       player stats row (from the nflverse-derived cache)
 * @param config  sports/nfl/config.json
 * @param ctx     { oppDefense, leagueRzTdRate, availability } — all optional; the
 *                model degrades to a neutral factor when a piece is missing so a
 *                failed injury fetch or an unknown opponent never breaks the build.
 */
export function scoreAtdPlayer(p, config, ctx = {}) {
  const m = config.model;
  const gp = p.gamesPlayed || 0;
  const tds = p.tds || 0;
  const tdRate = gp > 0 ? tds / gp : 0;
  const prior = m.prior[p.position] ?? 0.2;

  // regress observed TD/game toward the position prior
  let prob = (tdRate * gp + prior * m.priorWeight) / (gp + m.priorWeight);

  // --- role: 2026 depth-chart rank, else the 2025 snap-share heuristic ---
  // Depth rank is the better signal because it describes the player's role THIS
  // season. A 2025 backup who is now the starter (or a rookie RB1) is invisible to
  // snap share but obvious from depth rank, so rank wins whenever it is present.
  let roleFactor = 1, roleSource = 'none';
  if (p.depthRank != null) {
    const ladder = m.depthRoleFactor[p.position];
    roleFactor = ladder
      ? (ladder[Math.min(p.depthRank, ladder.length) - 1] ?? m.depthRoleFloor)
      : 1;
    roleFactor = Math.max(m.depthRoleFloor, roleFactor);
    roleSource = 'depth-2026';
    prob *= roleFactor;
  } else if (gp < m.lowRoleGamesThreshold && (p.snapShare || 0) < m.lowRoleSnapThreshold) {
    // fallback: limited snaps + few games => likely backup
    roleFactor = m.lowRoleReduction;
    roleSource = 'snap-2025';
    prob *= roleFactor;
  }

  // --- no 2025 production history ---
  // Rookies get the position prior shaped by draft capital (early picks are drafted
  // to be featured). Veterans with no history are likely fringe roster players, so
  // they take a penalty instead. Neither gets a fabricated sample.
  let historyFactor = 1;
  if (p.dataConfidence === 'rookie') {
    const d = p.draftNumber;
    const b = m.rookieDraftBoost;
    historyFactor = d == null ? b.later : d <= 32 ? b.round1 : d <= 64 ? b.round2 : d <= 105 ? b.round3 : b.later;
    prob *= historyFactor;
  } else if (p.dataConfidence === 'no-history') {
    historyFactor = m.noHistoryPenalty;
    prob *= historyFactor;
  }

  // red-zone involvement boost (heavy RZ usage raises future TD odds)
  const rzPerGame = gp > 0 ? (p.rzTargets + p.rzCarries) / gp : 0;
  prob *= 1 + Math.min(m.rzBoostMax, rzPerGame * m.rzBoostPerPlay);

  // --- matchup: opponent red-zone defense ---
  // rzDefIndex >1 means the opponent allows more TDs per red-zone play than league
  // average. Temper it by rzDefWeight (a full-strength index would overstate a
  // single-season signal) and clamp so no matchup can dominate the projection.
  const d = ctx.oppDefense;
  let rzDefIndex = 1, rzDefFactor = 1;
  if (d && (d.rzPlaysFaced || 0) >= m.rzDefMinPlaysFaced) {
    rzDefIndex = d.rzDefIndex;
    rzDefFactor = 1 + (rzDefIndex - 1) * m.rzDefWeight;
    rzDefFactor = Math.max(m.rzDefMin, Math.min(m.rzDefMax, rzDefFactor));
    prob *= rzDefFactor;
  }

  // --- availability ---
  // OUT/IR/suspended multiply to 0 (then get floored to minProb below, so the
  // player still renders but is unmistakably faded and flagged).
  const av = ctx.availability || null;
  const availStatus = av ? av.status : 'unconfirmed';
  const availFactor = av ? (m.availabilityMultiplier[av.status] ?? 1) : 1;
  prob *= availFactor;

  const isOut = availFactor === 0;
  prob = isOut ? 0 : Math.max(m.minProb, Math.min(m.maxProb, prob));
  const { grade, label } = isOut ? { grade: 'F', label: 'Out' } : gradeFor(prob, config.grades);
  return {
    probability: +prob.toFixed(4),
    grade, gradeLabel: label,
    dataConfidence: p.dataConfidence || 'full',
    isRookie: !!p.isRookie,
    availability: {
      status: availStatus,
      statusRaw: av?.statusRaw || null,
      detail: av?.detail || null,
      note: av?.comment || null,
      factor: availFactor,
    },
    inputs: {
      tdRate: +tdRate.toFixed(3),
      rzPerGame: +rzPerGame.toFixed(2),
      snapShare: p.snapShare || 0,
      gamesPlayed: gp,
      depthRank: p.depthRank ?? null,
      roleFactor: +roleFactor.toFixed(3),
      roleSource,
      historyFactor: +historyFactor.toFixed(3),
      oppRzDefIndex: rzDefIndex,
      oppRzDefFactor: +rzDefFactor.toFixed(3),
      oppRzTdRateAllowed: d?.rzTdRateAllowed ?? null,
      sampleYear: m.sampleYear,
      rosterYear: m.rosterYear,
    },
  };
}

// ESPN and nflverse disagree on a few team abbreviations. The stats cache is keyed
// by nflverse abbreviations, so canonicalize ESPN's to nflverse before any join —
// without this, Washington and the Rams silently produce ZERO players and a neutral
// red-zone-defense factor. Legacy relocation codes are included so older ESPN
// payloads and historical PBP seasons both land on the current franchise.
// Team-abbreviation canonicalization lives in ./teams.js (single source of truth,
// shared with availability.js and roster2026.js). Re-exported here because callers
// and tests already import these names from the adapter.
export { TEAM_ALIASES, canonTeam };

function teamFromCompetitor(comp) {
  const espnAbbr = comp.team?.abbreviation;
  return {
    abbr: canonTeam(espnAbbr),   // canonical, used for all stats/roster joins
    espnAbbr,                    // as ESPN reported it (kept for traceability)
    name: comp.team?.displayName,
    shortName: comp.team?.shortDisplayName,
    logo: comp.team?.logo,
    teamId: comp.team?.id,
    score: comp.score,
    records: (comp.records || []).map(r => ({ type: r.type, summary: r.summary })),
  };
}

async function fetchSchedule() {
  // Default (no --seasontype/--week): bare URL returns the current week's games
  // (ESPN infers season + type + week). With --seasontype/--week, query explicitly.
  let url = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
  if (SEASON_TYPE || WEEK) {
    const q = [`dates=${SEASON}`];
    if (SEASON_TYPE) q.push(`seasontype=${SEASON_TYPE}`);
    if (WEEK) q.push(`week=${WEEK}`);
    url += '?' + q.join('&');
  }
  const data = await fetchJSON(url);
  const season = data.leagues?.[0]?.season || {};
  const typeShort = TYPE_SHORT[SEASON_TYPE] || TYPE_SHORT[season.type?.id] || 'reg';
  const week = WEEK ? parseInt(WEEK, 10) : (season.week ? parseInt(season.week, 10) : 1);
  const events = data.events || [];
  return { events, season: parseInt(season.year || SEASON, 10), typeShort, week };
}

function buildGame(event, playersByTeam, config, ctx) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const comps = comp.competitors || [];
  const home = comps.find(c => c.homeAway === 'home') || comps[0];
  const away = comps.find(c => c.homeAway === 'away') || comps[1];
  const homeTeam = teamFromCompetitor(home);
  const awayTeam = teamFromCompetitor(away);

  // players on either roster (from 2025 baseline cache, matched by team abbr)
  const players = [];
  for (const abbr of [homeTeam.abbr, awayTeam.abbr]) {
    const roster = playersByTeam[abbr] || [];
    for (const p of roster) {
      const opp = (p.team === homeTeam.abbr) ? awayTeam.abbr : homeTeam.abbr;
      const atd = scoreAtdPlayer(p, config, {
        oppDefense: ctx.teamDefense?.[opp] || null,
        leagueRzTdRate: ctx.leagueRzTdRate,
        availability: lookupAvailability(ctx.availability, p),
      });
      players.push({
        gsisId: p.gsisId, espnId: p.espnId, name: p.name, team: p.team,
        position: p.position, depth: p.depth, jersey: p.jersey, headshot: p.headshot,
        depthRank: p.depthRank,
        yearsExp: p.yearsExp,
        isRookie: p.isRookie,
        prevTeam: p.prevTeam,
        teamChanged: p.teamChanged,
        stats: {
          snapShare: p.snapShare, gamesPlayed: p.gamesPlayed,
          rzTargets: p.rzTargets, rzCarries: p.rzCarries, tds: p.tds,
          statsSeason: p.gamesPlayed > 0 ? 2025 : null,
        },
        opponent: opp,
        props: { atd: { ...atd, oddsAvailable: config.availability.oddsAvailable } },
      });
    }
  }
  // grade-sorted: highest ATD probability first
  players.sort((a, b) => b.props.atd.probability - a.props.atd.probability);

  const oppDef = (t) => {
    const d = ctx.teamDefense?.[t];
    return d ? { rzTdRateAllowed: d.rzTdRateAllowed, rzDefIndex: d.rzDefIndex, rzPlaysFaced: d.rzPlaysFaced } : null;
  };

  return {
    gameId: event.id,
    startTimeUTC: comp.date || event.date,
    status: comp.status?.type?.state,          // pre, in, post
    statusDetail: comp.status?.type?.shortDetail,
    doubleHeader: false,
    venue: comp.venue ? { name: comp.venue.fullName, city: comp.venue.address?.city, indoor: !!comp.venue.indoor } : null,
    broadcast: (comp.broadcasts || []).map(b => ({ market: b.market, names: b.names })),
    away: { ...awayTeam, rzDefense: oppDef(awayTeam.abbr) },
    home: { ...homeTeam, rzDefense: oppDef(homeTeam.abbr) },
    players,
  };
}

export async function build() {
  const started = Date.now();
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const { players, teamDefense, leagueRzTdRate, warnings: statWarnings } = await loadOrBuildStatsCache(CACHE_PATH);

  // 2026 roster + depth chart is the source of truth for who exists and where they
  // play; the 2025 stats above only supply production history. Fail-soft: if the
  // 2026 layer is unavailable we fall back to the 2025 roster so the build still
  // produces a slate, with a warning saying the rosters are stale.
  let pool, blendStats = null, roster2026 = null, rosterWarnings = [];
  try {
    roster2026 = await loadOrBuildRoster2026Cache(ROSTER_CACHE_PATH, { force: process.argv.includes('--refresh-roster') });
    rosterWarnings = roster2026.warnings || [];
    const blended = blendRosters(players, roster2026);
    pool = blended.pool;
    blendStats = blended.stats;
  } catch (e) {
    rosterWarnings = [`roster2026: UNAVAILABLE (${String(e.message).slice(0, 90)}) — falling back to 2025 rosters; team assignments may be stale`];
    pool = Object.values(players).map(p => ({ ...p, depthRank: null, isRookie: false, dataConfidence: 'full', teamChanged: false, prevTeam: null }));
  }

  // index players by team abbr
  const playersByTeam = {};
  for (const p of pool) {
    (playersByTeam[p.team] = playersByTeam[p.team] || []).push(p);
  }

  // Coverage guard: an abbreviation mismatch between feeds fails SILENTLY (the team
  // just gets zero players). Assert every canonical team has a roster and surface any
  // gap as a loud warning rather than letting it ship as a quietly empty team.
  const emptyTeams = CANON_TEAMS.filter(t => !(playersByTeam[t]?.length));
  const unknownTeams = Object.keys(playersByTeam).filter(t => !CANON_TEAMS.includes(t));
  if (emptyTeams.length) rosterWarnings.push(`TEAM COVERAGE: ${emptyTeams.length} team(s) have NO players — ${emptyTeams.join(',')} (likely an abbreviation mismatch; check teams.js TEAM_ALIASES)`);
  if (unknownTeams.length) rosterWarnings.push(`TEAM COVERAGE: unrecognized team abbr(s) ${unknownTeams.join(',')} — add to teams.js TEAM_ALIASES`);

  // live availability (fail-soft: a failure leaves every status 'unconfirmed'
  // and the model applies a neutral factor rather than assuming everyone is active)
  const availability = SKIP_AVAIL
    ? { ok: false, warnings: ['availability: skipped via --no-availability'] }
    : await fetchAvailability();

  const { events, season, typeShort, week } = await fetchSchedule();
  const ctx = { teamDefense, leagueRzTdRate, availability };
  const games = events.map(e => buildGame(e, playersByTeam, config, ctx)).filter(Boolean);

  const playerCount = games.reduce((n, g) => n + g.players.length, 0);
  const availCounts = {};
  const confCounts = {};
  for (const g of games) for (const p of g.players) {
    const s = p.props.atd.availability.status;
    availCounts[s] = (availCounts[s] || 0) + 1;
    const c = p.props.atd.dataConfidence;
    confCounts[c] = (confCounts[c] || 0) + 1;
  }
  const payload = {
    sport: 'nfl',
    slateId: slateId(season, typeShort, week),
    date: arg('--date', new Date().toISOString().slice(0, 10)),
    season, seasonType: typeShort, week,
    generatedAt: new Date().toISOString(),
    buildDurationMs: Date.now() - started,
    gameCount: games.length,
    availability: {
      source: config.availability.source,
      ok: !!availability.ok,
      fetchedAt: availability.fetchedAt || null,
      counts: availCounts,
    },
    leagueRzTdRate,
    rosters: {
      rosterYear: 2026,
      statsYear: 2025,
      source: roster2026 ? 'nflverse roster_2026 + depth_charts_2026' : 'fallback: nflverse 2025',
      depthSnapshot: roster2026?.latestDepthSnapshot || null,
      dataConfidence: confCounts,
      blend: blendStats,
    },
    sources: {
      schedule: 'ESPN hidden API (CC-BY-NC 4.0, ESPN)',
      rosters: 'nflverse 2026 (roster + depth_charts, CC-BY 4.0)',
      players: 'nflverse 2025 (roster + snap_counts + pbp, CC-BY 4.0)',
      stats: 'nflverse 2025 regular season (production baseline)',
      injuries: 'ESPN injuries endpoint (live)',
      model: 'regressed-touchdown-rate + 2026 depth-chart role + opponent red-zone defense + availability (self-contained, v1.2)',
    },
    warnings: [
      `production baseline: 2025 regular season (2026 games not yet played)`,
      `rosters: nflverse 2026 — current teams, rookies and depth-chart role are reflected`,
      `carryover: a traded player's 2025 rate travels with him; his 2026 opportunity is captured by depth rank, not by his old team's usage`,
      `rz-defense: opponent red-zone TD rate allowed is a 2025 signal, tempered by rzDefWeight=${config.model.rzDefWeight}`,
      `odds/inactives: ${config.availability.note}`,
      ...rosterWarnings,
      ...(availability.warnings || []),
      ...statWarnings,
    ],
    games,
  };
  if (VERBOSE) console.log(`  nfl ${payload.slateId}: ${games.length} games, ${playerCount} players graded, confidence=${JSON.stringify(confCounts)}, availability=${JSON.stringify(availCounts)}`);
  await writeOut(payload);
  return payload;
}

export async function writeOut(payload) {
  if (process.argv.includes('--stdout')) { console.log(JSON.stringify(payload, null, 2)); return; }
  await mkdir(pathDirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${OUT} — ${payload.gameCount} games, sport=${payload.sport}, slateId=${payload.slateId}`);
}
