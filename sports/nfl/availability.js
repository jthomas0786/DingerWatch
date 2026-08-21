// sports/nfl/availability.js — live player availability from the ESPN league-wide
// injuries endpoint.
//
// Why ESPN and not nflverse: nflverse's injury feed died after the 2024 season
// (no 2025/2026 data, no ETA), so it cannot supply current availability. ESPN's
// injuries endpoint is undocumented but reachable from cloud IPs / GitHub Actions
// and carries per-player status for all 32 teams.
//
// Joining: the endpoint does NOT expose athlete.id directly, but the ESPN athlete
// id is embedded in every athlete link href (/nfl/player/_/id/<id>/<slug>), and
// our stats cache carries espn_id from the nflverse roster — so we join on that,
// with a normalized name+team fallback for players whose espn_id is missing.
//
// Fail-soft by design: any fetch/parse failure returns an empty map plus a warning,
// and the adapter falls back to availabilityStatus 'unconfirmed' rather than
// silently treating injured players as active.

const UA = 'dinger-watch-slate-builder/1.0';
const INJURIES_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

// ESPN status string -> our normalized availability
export const STATUS_MAP = {
  'Active': 'active',
  'Questionable': 'questionable',
  'Doubtful': 'doubtful',
  'Out': 'out',
  'Injured Reserve': 'out',
  'Suspension': 'out',
  'Physically Unable to Perform': 'out',
  'Non Football Injury': 'out',
};

// ESPN's injuries feed reports ESPN team abbreviations (WSH, LAR); the stats cache is
// keyed by nflverse abbreviations (WAS, LA). Canonicalize so the name+team fallback
// key matches. The alias table is shared — see ./teams.js (teams.js imports nothing
// from this module, so there is no circular import).
import { canonTeam } from './teams.js';

export function normName(name) {
  return String(name || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .replace(/[.'`\u2019-]/g, '')                        // strip punctuation
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '')              // strip generational suffix
    .replace(/\s+/g, ' ').trim();
}

function espnIdFromLinks(athlete) {
  for (const l of athlete?.links || []) {
    const m = /\/id\/(\d+)(?:\/|$)/.exec(l.href || '');
    if (m) return m[1];
  }
  return null;
}

/**
 * Fetch live availability.
 * @returns {Promise<{byEspnId: Map<string,object>, byNameTeam: Map<string,object>, fetchedAt: string|null, ok: boolean, warnings: string[]}>}
 */
export async function fetchAvailability() {
  const byEspnId = new Map();
  const byNameTeam = new Map();
  const warnings = [];
  let fetchedAt = null;

  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30000);
  let data;
  try {
    const r = await fetch(INJURIES_URL, { signal: c.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    clearTimeout(t);
    warnings.push(`availability: ESPN injuries fetch failed (${String(e.message).slice(0, 80)}) — statuses unconfirmed`);
    return { byEspnId, byNameTeam, fetchedAt, ok: false, warnings };
  } finally { clearTimeout(t); }

  fetchedAt = data.timestamp || new Date().toISOString();
  let entries = 0;
  for (const team of data.injuries || []) {
    for (const e of team.injuries || []) {
      entries++;
      const raw = String(e.status || '');
      const status = STATUS_MAP[raw] || 'unknown';
      const teamAbbr = canonTeam(e.athlete?.team?.abbreviation || '');
      const rec = {
        status,
        statusRaw: raw,
        abbreviation: e.type?.abbreviation || '',
        detail: e.details?.type || e.type?.description || '',
        comment: e.shortComment || '',
        date: e.date || '',
        team: teamAbbr,
      };
      const id = espnIdFromLinks(e.athlete);
      if (id) byEspnId.set(String(id), rec);
      const nm = normName(e.athlete?.displayName);
      if (nm && teamAbbr) byNameTeam.set(`${nm}|${teamAbbr}`, rec);
    }
  }
  warnings.push(`availability: ${entries} ESPN injury entries (${byEspnId.size} with ids), as of ${fetchedAt}`);
  return { byEspnId, byNameTeam, fetchedAt, ok: true, warnings };
}

/** Look up one player's availability. Returns null when not listed. */
export function lookupAvailability(avail, player) {
  if (!avail?.ok) return null;
  if (player.espnId) {
    const hit = avail.byEspnId.get(String(player.espnId));
    if (hit) return hit;
  }
  const nm = normName(player.name);
  if (nm && player.team) {
    const hit = avail.byNameTeam.get(`${nm}|${canonTeam(player.team)}`);
    if (hit) return hit;
  }
  return null;
}
