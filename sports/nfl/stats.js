// sports/nfl/stats.js — builds a compact per-player stats cache from nflverse
// 2025 regular-season data. The roster file is the player master (it carries
// gsis_id, pfr_id, full_name, headshot_url, team, position, depth); snap counts
// and play-by-play are joined by ID (pfr_id and gsis_id respectively), NOT by
// name — nflverse PBP uses short "J.Taylor" names that don't match the full
// names in snap counts, so ID joins are required.
//
// nflverse data is CC-BY 4.0 (attribution: nflverse). Raw CSVs are never
// committed — only this derived aggregate cache is written, and it is gitignored.
// Regenerated when missing or older than STALE_MS (weekly CI refresh).

import { readFile, writeFile, stat } from 'node:fs/promises';
import { iterCSV, headerMap } from './csv.js';

const UA = 'dinger-watch-slate-builder/1.0';
const ROSTER_URL = 'https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2025.csv';
const SNAP_URL = 'https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_2025.csv';
const PBP_URL = 'https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.csv';
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const SKILL_POS = new Set(['QB', 'RB', 'WR', 'TE']);

async function fetchText(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 120000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const blank = (meta) => ({
  ...meta,
  snapShare: 0, gamesPlayed: 0, rzTargets: 0, rzCarries: 0, tds: 0,
});

/** Build the stats cache from nflverse. Returns { players, warnings }. */
export async function buildStatsCache() {
  const warnings = [];

  // --- 1. roster = player master (latest REG-week snapshot per player) ---
  // File is ordered by season/week, so overwriting yields the latest week's row.
  const byGsis = new Map();      // gsis_id -> player
  const pfrToGsis = new Map();  // pfr_id -> gsis_id (for snap_counts join)
  const rosterText = await fetchText(ROSTER_URL);
  const rosterHeader = headerMap(rosterText.slice(0, rosterText.indexOf('\n')));
  let rosterRows = 0;
  iterCSV(rosterText, rosterHeader, ['team', 'position', 'depth_chart_position', 'jersey_number', 'status', 'full_name', 'gsis_id', 'espn_id', 'pfr_id', 'week', 'headshot_url'], (r) => {
    rosterRows++;
    const pos = r.position;
    if (!SKILL_POS.has(pos)) return;
    const gsis = r.gsis_id;
    if (!gsis) return;
    // roster_2025.csv is one snapshot per player (their latest 2025 week, which
    // may be a playoff week) — do NOT filter by game_type. Drop players who were
    // clearly inactive/cut/retired at their snapshot so the 2026 baseline is
    // current-roster-only (keeps ACT/RES/DEV).
    if (['INA', 'CUT', 'RET', 'EXE'].includes(r.status)) return;
    const meta = {
      name: r.full_name, team: (r.team || '').toUpperCase(), position: pos,
      depth: r.depth_chart_position || '', jersey: r.jersey_number || '', status: r.status || '',
      espnId: r.espn_id || '', gsisId: gsis, pfrId: r.pfr_id || '', headshot: r.headshot_url || '',
    };
    byGsis.set(gsis, blank(meta));
    if (r.pfr_id) pfrToGsis.set(r.pfr_id, gsis);
  });
  warnings.push(`roster: ${rosterRows} rows, ${byGsis.size} skill players`);

  // --- 2. snap counts → snap share, joined by pfr_id ---
  const snapText = await fetchText(SNAP_URL);
  const snapHeader = headerMap(snapText.slice(0, snapText.indexOf('\n')));
  let snapRows = 0, snapMatched = 0;
  iterCSV(snapText, snapHeader, ['player', 'pfr_player_id', 'position', 'team', 'offense_snaps', 'offense_pct', 'game_type'], (r) => {
    snapRows++;
    if (r.game_type !== 'REG') return;
    const snaps = parseInt(r.offense_snaps, 10) || 0;
    if (snaps <= 0) return;
    const gsis = pfrToGsis.get(r.pfr_player_id);
    if (!gsis) return;
    const p = byGsis.get(gsis);
    if (!p) return;
    p.snapShare += parseFloat(r.offense_pct) || 0;
    p.gamesPlayed++;
    snapMatched++;
  });
  for (const p of byGsis.values()) if (p.gamesPlayed > 0) p.snapShare = +(p.snapShare / p.gamesPlayed).toFixed(3);
  warnings.push(`snap_counts: ${snapRows} rows, ${snapMatched} matched`);

  // --- 3. play-by-play → red-zone usage + TDs, joined by gsis_id ---
  const pbpText = await fetchText(PBP_URL);
  const pbpHeader = headerMap(pbpText.slice(0, pbpText.indexOf('\n')));
  let pbpRows = 0, tdMatched = 0, rzMatched = 0;
  iterCSV(pbpText, pbpHeader, ['yardline_100', 'td_player_id', 'td_player_name', 'receiver_player_id', 'receiver_player_name', 'rusher_player_id', 'rusher_player_name', 'posteam', 'season_type'], (r) => {
    pbpRows++;
    if (r.season_type !== 'REG') return;
    if (r.td_player_id) {
      const p = byGsis.get(r.td_player_id);
      if (p) { p.tds++; tdMatched++; }
    }
    const yl = parseFloat(r.yardline_100);
    if (!isNaN(yl) && yl <= 20) {
      if (r.receiver_player_id) { const p = byGsis.get(r.receiver_player_id); if (p) { p.rzTargets++; rzMatched++; } }
      if (r.rusher_player_id) { const p = byGsis.get(r.rusher_player_id); if (p) { p.rzCarries++; rzMatched++; } }
    }
  });
  warnings.push(`pbp: ${pbpRows} rows, ${tdMatched} TDs + ${rzMatched} RZ plays matched`);

  // serialize keyed by gsis_id
  const players = {};
  for (const [gsis, p] of byGsis) players[gsis] = p;
  return { players, warnings };
}

/** Load the cache from disk if fresh, else rebuild + persist. */
export async function loadOrBuildStatsCache(cachePath, opts = {}) {
  let age = Infinity;
  try { const s = await stat(cachePath); age = Date.now() - s.mtimeMs; } catch { /* missing */ }
  if (!opts.force && age < STALE_MS) {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  }
  const built = await buildStatsCache();
  await writeFile(cachePath, JSON.stringify(built), 'utf8');
  return built;
}
