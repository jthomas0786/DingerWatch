// sports/nfl/teams.js — single source of truth for NFL team-abbreviation canonicalization.
//
// The three feeds this model consumes do NOT agree on team abbreviations, and a
// mismatch fails SILENTLY: a team simply ends up with zero players in every slate.
// That bug has bitten twice (ESPN WSH/LAR vs nflverse WAS/LA, then nflverse 2026's
// AZ vs 2025's ARI), so all abbreviations from every source go through canonTeam()
// and the alias table lives in exactly one place.
//
// Canonical form = the nflverse historical form used by the 2025 stats baseline
// (ARI, LA, WAS, JAX, ...), because that is what player stats are keyed to.
//
// Known divergences:
//   ESPN scoreboard/injuries : WSH, LAR
//   nflverse roster_2026     : AZ
//   nflverse historical/misc : ARZ, JAC, OAK, SD, STL, BLT, CLV, HST

export const TEAM_ALIASES = {
  WSH: 'WAS',  // ESPN -> nflverse
  LAR: 'LA',   // ESPN -> nflverse
  AZ: 'ARI',   // nflverse 2026 roster -> nflverse historical
  ARZ: 'ARI',
  JAC: 'JAX',
  OAK: 'LV',   // relocation
  SD: 'LAC',   // relocation
  STL: 'LA',   // relocation
  BLT: 'BAL',
  CLV: 'CLE',
  HST: 'HOU',
};

/** Normalize any feed's team abbreviation to the canonical (nflverse) form. */
export function canonTeam(abbr) {
  const a = String(abbr || '').toUpperCase();
  return TEAM_ALIASES[a] || a;
}

/** Every canonical team abbreviation, for coverage assertions. */
export const CANON_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LA', 'LAC', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];
