/**
 * sports/registry.js — the single source of truth for every sport vertical.
 *
 * Adding a sport is a config exercise, not a rewrite: declare it here, give it
 * an adapter at sports/<key>/adapter.js, and the build driver + UI pick it up.
 *
 * Phase 0 ships only `mlb` as adapter-ready. The other three are declared so the
 * sport switcher can render them as "coming soon" — they light up in their phases.
 *
 * Two independent readiness flags, deliberately separate:
 *   adapterReady — the sport is BLESSED. Its pill is enabled in the switcher and
 *                  it is offered to users. Flip this only after QA passes.
 *   uiReady      — a view for this sport EXISTS and can be rendered. Lets the NFL
 *                  view be built and QA'd behind a #hash without advertising it,
 *                  and shows a "preview" banner while adapterReady is still false.
 */
export const SPORTS = {
  mlb: {
    brand: 'MLB',     short: 'MLB',     accent: '#22c55e',
    slateUnit: 'day',          primaryProp: 'hr',
    eventNoun: 'home run',     eventVerb: 'went deep',
    matchupLabel: 'vs SP',     lineupSource: 'api',
    adapterReady: true,        seasonStart: null,
    uiReady: true,
    slateUrl: './slate.json',
    props: ['hr', 'hits', 'tb', 'rbi', 'hrr', 'sb'],
  },
  nfl: {
    brand: 'NFL', short: 'NFL',  accent: '#f59e0b',
    slateUnit: 'week',         primaryProp: 'atd',
    eventNoun: 'touchdown',    eventVerb: 'found the end zone',
    matchupLabel: 'vs Defense',lineupSource: 'inactives',
    adapterReady: true,        seasonStart: '2026-09-09',
    uiReady: true,
    slateUrl: './slates/nfl.json',
    props: ['atd', 'rushYds', 'recYds', 'receptions', 'passTds'],
  },
  nhl: {
    brand: 'NHL',      short: 'NHL',        accent: '#38bdf8',
    slateUnit: 'day',          primaryProp: 'atg',
    eventNoun: 'goal',         eventVerb: 'lit the lamp',
    matchupLabel: 'vs Goalie', lineupSource: 'goalie',
    adapterReady: false,       seasonStart: '2026-09-29',
    uiReady: false,
    slateUrl: './slates/nhl.json',
    props: ['atg', 'sog', 'points', 'assists', 'blocks'],
  },
  nba: {
    brand: 'NBA',    short: 'NBA',      accent: '#a855f7',
    slateUnit: 'day',          primaryProp: 'pts',
    eventNoun: 'bucket',       eventVerb: 'got buckets',
    matchupLabel: 'vs Opponent', lineupSource: 'injury_report',
    adapterReady: false,       seasonStart: '2026-10-20',
    uiReady: false,
    slateUrl: './slates/nba.json',
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

/** True when this sport has a renderable view (may still be an unblessed preview). */
export function isViewable(key) {
  const s = SPORTS[key];
  return !!(s && s.uiReady);
}

/** True when the sport is built but not yet blessed — render a preview banner. */
export function isPreview(key) {
  const s = SPORTS[key];
  return !!(s && s.uiReady && !s.adapterReady);
}
