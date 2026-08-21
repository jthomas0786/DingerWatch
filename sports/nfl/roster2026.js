// sports/nfl/roster2026.js — current-season (2026) roster + depth-chart layer.
//
// Why this exists: the ATD model's production stats come from nflverse 2025 (the
// last completed season). On its own that means players project onto their OLD
// team, 2026 rookies don't exist at all, and departed players still appear. This
// module supplies the current-season truth that gets blended over that baseline:
//
//   roster_2026.csv       -> current team, position, jersey, status, experience,
//                            draft capital, headshot
//   depth_charts_2026.csv -> pos_rank (1 = starter) from the most recent snapshot,
//                            which is the single best available signal for a
//                            player's 2026 ROLE (2025 snap share describes a role
//                            that may no longer exist)
//
// Cached separately from the 2025 stats cache: 2025 stats are immutable, but depth
// charts move daily through camp, so this layer gets a short TTL.

import { readFile, writeFile } from 'node:fs/promises';
import { iterCSV, headerMap } from './csv.js';
import { canonTeam } from './teams.js';

const UA = 'dinger-watch-slate-builder/1.0';
const SEASON = 2026;
const ROSTER_URL = `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${SEASON}.csv`;
const DEPTH_URL = `https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_${SEASON}.csv`;

export const STALE_MS = 12 * 60 * 60 * 1000; // 12h — depth charts change daily in camp
export const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE']);

// Statuses that mean "not on the active roster in any meaningful sense".
// RES (reserve/IR) and E14 are kept but flagged — ESPN's injury feed is the
// authority on game-level availability, and we don't want to silently delete a
// player who may be activated.
const DROP_STATUS = new Set(['RET', 'CUT']);

async function fetchText(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 180000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

export async function buildRoster2026Cache() {
  const warnings = [];

  // --- 1. current roster ---
  const rosterText = await fetchText(ROSTER_URL);
  const rh = headerMap(rosterText.slice(0, rosterText.indexOf('\n')));
  const players = {};
  let rosterRows = 0, skill = 0, dropped = 0;
  const teams = new Set();
  iterCSV(rosterText, rh, ['season', 'team', 'position', 'depth_chart_position', 'jersey_number',
    'status', 'full_name', 'gsis_id', 'espn_id', 'pfr_id', 'years_exp', 'rookie_year',
    'draft_number', 'draft_club', 'headshot_url'], (r) => {
    rosterRows++;
    if (!SKILL_POS.has(r.position)) return;
    if (!r.gsis_id) return;
    if (DROP_STATUS.has(r.status)) { dropped++; return; }
    skill++;
    const team = canonTeam(r.team);   // 2026 roster uses AZ where 2025 stats use ARI
    teams.add(team);
    const yearsExp = r.years_exp === '' ? null : parseInt(r.years_exp, 10);
    players[r.gsis_id] = {
      gsisId: r.gsis_id,
      espnId: r.espn_id || null,
      pfrId: r.pfr_id || null,
      name: r.full_name,
      team,
      position: r.position,
      depthPosition: r.depth_chart_position || r.position,
      jersey: r.jersey_number || null,
      status2026: r.status,
      yearsExp,
      isRookie: yearsExp === 0,
      rookieYear: r.rookie_year ? parseInt(r.rookie_year, 10) : null,
      draftNumber: r.draft_number ? parseInt(r.draft_number, 10) : null,
      draftClub: r.draft_club || null,
      headshot: r.headshot_url || null,
      depthRank: null,      // filled from depth chart below
      depthSnapshot: null,
    };
  });
  warnings.push(`roster2026: ${rosterRows} rows, ${skill} skill players on ${teams.size} teams (${dropped} RET/CUT dropped)`);

  // --- 2. depth chart: keep only the most recent snapshot per player ---
  // The file holds every snapshot taken since March, so track the max timestamp
  // seen per player and keep the best (lowest) rank at that timestamp.
  let depthRows = 0, depthMatched = 0, latestDt = '';
  try {
    const depthText = await fetchText(DEPTH_URL);
    const dh = headerMap(depthText.slice(0, depthText.indexOf('\n')));
    const best = new Map(); // gsis -> { dt, rank }
    iterCSV(depthText, dh, ['dt', 'team', 'player_name', 'espn_id', 'gsis_id', 'pos_abb', 'pos_rank'], (r) => {
      depthRows++;
      if (!r.gsis_id || !SKILL_POS.has(r.pos_abb)) return;
      const rank = parseInt(r.pos_rank, 10);
      if (!Number.isFinite(rank)) return;
      const dt = r.dt || '';
      if (!/^\d{4}-/.test(dt)) return;              // skip malformed / header echoes
      if (dt > latestDt) latestDt = dt;
      const cur = best.get(r.gsis_id);
      if (!cur || dt > cur.dt || (dt === cur.dt && rank < cur.rank)) best.set(r.gsis_id, { dt, rank });
    });
    // Only trust ranks from a recent snapshot — a stale March rank is worse than none.
    for (const [gsis, v] of best) {
      const p = players[gsis];
      if (!p) continue;
      p.depthRank = v.rank;
      p.depthSnapshot = v.dt;
      depthMatched++;
    }
    warnings.push(`depth2026: ${depthRows} rows, ${depthMatched} players ranked, latest snapshot ${latestDt}`);
  } catch (e) {
    warnings.push(`depth2026: unavailable (${String(e.message).slice(0, 80)}) — falling back to 2025 snap share for role`);
  }

  return { season: SEASON, players, teams: [...teams].sort(), latestDepthSnapshot: latestDt || null, builtAt: new Date().toISOString(), warnings };
}

export async function loadOrBuildRoster2026Cache(cachePath, opts = {}) {
  if (!opts.force) {
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8'));
      const age = Date.now() - new Date(raw.builtAt).getTime();
      if (age < STALE_MS && raw.players && Object.keys(raw.players).length > 0) {
        return { ...raw, warnings: [...(raw.warnings || []), `roster2026: cache hit (${Math.round(age / 3.6e6)}h old)`] };
      }
    } catch { /* miss -> rebuild */ }
  }
  const built = await buildRoster2026Cache();
  try { await writeFile(cachePath, JSON.stringify(built)); } catch { /* cache write is best-effort */ }
  return built;
}

/**
 * Blend 2026 roster/depth truth over the 2025 production baseline.
 *
 * The 2026 roster is the SOURCE OF TRUTH for who exists and what team they're on;
 * 2025 supplies production history. A player on a 2026 roster with no 2025 stats
 * is a rookie or a non-contributor and gets a prior-only projection, flagged via
 * dataConfidence so the UI can say so rather than implying a real sample.
 *
 * @returns {{pool: object[], stats: object}}
 */
export function blendRosters(stats2025Players, roster2026) {
  const pool = [];
  const stats = { full: 0, rookie: 0, noHistory: 0, teamChanged: 0, departed: 0, ranked: 0 };
  const seen2025 = new Set();

  for (const p26 of Object.values(roster2026.players || {})) {
    const s = stats2025Players[p26.gsisId] || null;
    if (s) seen2025.add(p26.gsisId);

    const teamChanged = !!(s && s.team && s.team !== p26.team);
    if (teamChanged) stats.teamChanged++;
    if (p26.depthRank != null) stats.ranked++;

    let dataConfidence;
    if (s && (s.gamesPlayed || 0) > 0) { dataConfidence = 'full'; stats.full++; }
    else if (p26.isRookie) { dataConfidence = 'rookie'; stats.rookie++; }
    else { dataConfidence = 'no-history'; stats.noHistory++; }

    pool.push({
      gsisId: p26.gsisId,
      espnId: p26.espnId || s?.espnId || null,
      name: p26.name || s?.name,
      team: p26.team,                       // 2026 team wins
      position: p26.position,
      depth: p26.depthPosition,
      jersey: p26.jersey || s?.jersey || null,
      headshot: p26.headshot || s?.headshot || null,
      depthRank: p26.depthRank,
      depthSnapshot: p26.depthSnapshot,
      yearsExp: p26.yearsExp,
      isRookie: !!p26.isRookie,
      draftNumber: p26.draftNumber,
      status2026: p26.status2026,
      // 2025 production (zeros when there is no history)
      gamesPlayed: s?.gamesPlayed || 0,
      tds: s?.tds || 0,
      rzTargets: s?.rzTargets || 0,
      rzCarries: s?.rzCarries || 0,
      snapShare: s?.snapShare || 0,
      prevTeam: s?.team || null,
      teamChanged,
      dataConfidence,
    });
  }

  // players who produced in 2025 but are on no 2026 roster (retired/cut/unsigned)
  for (const gsis of Object.keys(stats2025Players)) {
    if (!seen2025.has(gsis) && (stats2025Players[gsis].tds || 0) > 0) stats.departed++;
  }

  return { pool, stats };
}
