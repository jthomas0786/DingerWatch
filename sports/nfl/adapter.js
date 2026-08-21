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

const UA = 'dinger-watch-slate-builder/1.0';
const CACHE_PATH = '/tmp/nfl_stats_2025.json';
const HERE = fileURLToPath(new URL('./', import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SEASON = arg('--season', '2026');
const SEASON_TYPE = arg('--seasontype'); // 1=pre 2=reg 3=post, or null=current
const WEEK = arg('--week');              // or null=current
const OUT = arg('--out', 'public/slates/nfl.json');
const VERBOSE = process.argv.includes('--verbose');

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
export function scoreAtdPlayer(p, config) {
  const m = config.model;
  const gp = p.gamesPlayed || 0;
  const tds = p.tds || 0;
  const tdRate = gp > 0 ? tds / gp : 0;
  const prior = m.prior[p.position] ?? 0.2;

  // regress observed TD/game toward the position prior
  let prob = (tdRate * gp + prior * m.priorWeight) / (gp + m.priorWeight);

  // low-role discount: limited snaps + few games => likely backup
  if (gp < m.lowRoleGamesThreshold && (p.snapShare || 0) < m.lowRoleSnapThreshold) {
    prob *= m.lowRoleReduction;
  }

  // red-zone involvement boost (heavy RZ usage raises future TD odds)
  const rzPerGame = gp > 0 ? (p.rzTargets + p.rzCarries) / gp : 0;
  prob *= 1 + Math.min(m.rzBoostMax, rzPerGame * m.rzBoostPerPlay);

  // matchup (neutral in MVP — OpticOdds + opponent rz-defense wiring is a follow-up)
  prob *= m.matchupWeight;

  prob = Math.max(m.minProb, Math.min(m.maxProb, prob));
  const { grade, label } = gradeFor(prob, config.grades);
  return {
    probability: +prob.toFixed(4),
    grade, gradeLabel: label,
    inputs: {
      tdRate: +tdRate.toFixed(3),
      rzPerGame: +rzPerGame.toFixed(2),
      snapShare: p.snapShare || 0,
      gamesPlayed: gp,
      sampleYear: m.sampleYear,
    },
  };
}

function teamFromCompetitor(comp) {
  return {
    abbr: comp.team?.abbreviation,
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

function buildGame(event, playersByTeam, config) {
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
      players.push({
        gsisId: p.gsisId, espnId: p.espnId, name: p.name, team: p.team,
        position: p.position, depth: p.depth, jersey: p.jersey, headshot: p.headshot,
        stats: {
          snapShare: p.snapShare, gamesPlayed: p.gamesPlayed,
          rzTargets: p.rzTargets, rzCarries: p.rzCarries, tds: p.tds,
        },
        opponent: opp,
        props: { atd: { ...scoreAtdPlayer(p, config), oddsAvailable: config.availability.oddsAvailable, availabilityStatus: config.availability.availabilityStatus } },
      });
    }
  }
  // grade-sorted: highest ATD probability first
  players.sort((a, b) => b.props.atd.probability - a.props.atd.probability);

  return {
    gameId: event.id,
    startTimeUTC: comp.date || event.date,
    status: comp.status?.type?.state,          // pre, in, post
    statusDetail: comp.status?.type?.shortDetail,
    doubleHeader: false,
    venue: comp.venue ? { name: comp.venue.fullName, city: comp.venue.address?.city, indoor: !!comp.venue.indoor } : null,
    broadcast: (comp.broadcasts || []).map(b => ({ market: b.market, names: b.names })),
    away: awayTeam,
    home: homeTeam,
    players,
  };
}

export async function build() {
  const started = Date.now();
  const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
  const { players, warnings: statWarnings } = await loadOrBuildStatsCache(CACHE_PATH);

  // index players by team abbr
  const playersByTeam = {};
  for (const p of Object.values(players)) {
    (playersByTeam[p.team] = playersByTeam[p.team] || []).push(p);
  }

  const { events, season, typeShort, week } = await fetchSchedule();
  const games = events.map(e => buildGame(e, playersByTeam, config)).filter(Boolean);

  const playerCount = games.reduce((n, g) => n + g.players.length, 0);
  const payload = {
    sport: 'nfl',
    slateId: slateId(season, typeShort, week),
    date: arg('--date', new Date().toISOString().slice(0, 10)),
    season, seasonType: typeShort, week,
    generatedAt: new Date().toISOString(),
    buildDurationMs: Date.now() - started,
    gameCount: games.length,
    sources: {
      schedule: 'ESPN hidden API (CC-BY-NC 4.0, ESPN)',
      players: 'nflverse 2025 (roster + snap_counts + pbp, CC-BY 4.0)',
      stats: 'nflverse 2025 regular season',
      model: 'regressed-touchdown-rate (self-contained, v1)',
    },
    warnings: [
      `sampleYear: 2025 (2026 regular-season games not yet available; baseline = last season)`,
      `rosters: 2025 end-of-season; 2026 free-agency/draft moves not reflected`,
      `odds/inactives: ${config.availability.note}`,
      ...statWarnings,
    ],
    games,
  };
  if (VERBOSE) console.log(`  nfl ${payload.slateId}: ${games.length} games, ${playerCount} players graded`);
  await writeOut(payload);
  return payload;
}

export async function writeOut(payload) {
  if (process.argv.includes('--stdout')) { console.log(JSON.stringify(payload, null, 2)); return; }
  await mkdir(pathDirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${OUT} — ${payload.gameCount} games, sport=${payload.sport}, slateId=${payload.slateId}`);
}
