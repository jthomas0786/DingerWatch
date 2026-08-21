/**
 * sports/registry.js — the single source of truth for every sport vertical.
 *
 * Adding a sport is a config exercise, not a rewrite: declare it here, give it
 * an adapter at sports/<key>/adapter.js, and the build driver + UI pick it up.
 *
 * Phase 0 ships only `mlb` as adapter-ready. The other three are declared so the
 * sport switcher can render them as "coming soon" — they light up in their phases.
 */
export const SPORTS = {
  mlb: {
    brand: 'Dinger Watch',     short: 'Dinger',     accent: '#22c55e',
    slateUnit: 'day',          primaryProp: 'hr',
    eventNoun: 'home run',     eventVerb: 'went deep',
    matchupLabel: 'vs SP',     lineupSource: 'api',
    adapterReady: true,        seasonStart: null,
    props: ['hr', 'hits', 'tb', 'rbi', 'hrr', 'sb'],
  },
  nfl: {
    brand: 'Touchdown Watch', short: 'Touchdown',  accent: '#f59e0b',
    slateUnit: 'week',         primaryProp: 'atd',
    eventNoun: 'touchdown',    eventVerb: 'found the end zone',
    matchupLabel: 'vs Defense',lineupSource: 'inactives',
    adapterReady: false,       seasonStart: '2026-09-09',
    props: ['atd', 'rushYds', 'recYds', 'receptions', 'passTds'],
  },
  nhl: {
    brand: 'Goal Watch',      short: 'Goal',        accent: '#38bdf8',
    slateUnit: 'day',          primaryProp: 'atg',
    eventNoun: 'goal',         eventVerb: 'lit the lamp',
    matchupLabel: 'vs Goalie', lineupSource: 'goalie',
    adapterReady: false,       seasonStart: '2026-09-29',
    props: ['atg', 'sog', 'points', 'assists', 'blocks'],
  },
  nba: {
    brand: 'Bucket Watch',    short: 'Bucket',      accent: '#a855f7',
    slateUnit: 'day',          primaryProp: 'pts',
    eventNoun: 'bucket',       eventVerb: 'got buckets',
    matchupLabel: 'vs Opponent', lineupSource: 'injury_report',
    adapterReady: false,       seasonStart: '2026-10-20',
    modelType: 'regression',
    props: ['pts', 'reb', 'ast', 'threes', 'pra'],
  },
};

export const DEFAULT_SPORT = 'mlb';
export const SPORT_ORDER = ['mlb', 'nfl', 'nhl', 'nba'];

/** Resolve a sport key from a hash fragment like "#nfl" (or "" / "#mlb"). */
export function sportFromHash(hash) {
  const key = (hash || '').replace(/^#/, '').trim().toLowerCase();
  return SPORTS[key] ? key : DEFAULT_SPORT;
}
