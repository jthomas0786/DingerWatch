/**
 * sports/labels.js — sport-aware terminology for the UI.
 *
 * Never hardcode "home run" (or any sport noun) in the UI again. Every sport
 * declares its own noun/verb/matchup label in the registry; this module hands
 * the active sport's labels to anything that needs them.
 */
import { SPORTS, DEFAULT_SPORT } from './registry.js';

/** Labels for a sport key. Falls back to the default sport if unknown. */
export function labels(sport) {
  const s = SPORTS[sport] || SPORTS[DEFAULT_SPORT];
  return {
    brand: s.brand,
    short: s.short,
    accent: s.accent,
    eventNoun: s.eventNoun,
    eventVerb: s.eventVerb,
    matchupLabel: s.matchupLabel,
    primaryProp: s.primaryProp,
    slateUnit: s.slateUnit,
  };
}

/** Human phrase for a single event, e.g. "Mookie Betts went deep". */
export function eventPhrase(sport, playerName) {
  const l = labels(sport);
  return `${playerName} ${l.eventVerb}`;
}
