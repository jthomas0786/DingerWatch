/**
 * sports/nfl/winprob.js — modeled in-game win probability for NFL football.
 *
 * Design (logistic point-edge model, reviewed for calibration):
 *  - Pre-game prior comes from de-vigged moneyline odds when present, else from
 *    each team's W-L record (shrink-pulled toward .500 and given a mild
 *    home-field edge). A 12-4 team vs a 4-12 team lands near 0.70, not 0.95.
 *  - Live: an "edge" in points is built from the current score lead, a
 *    strength-prior edge that decays as the clock runs out, and a possession
 *    edge (the football analog of MLB's base/out run expectancy — the team
 *    with the ball has positive expected points from the current drive).
 *  - The edge is squashed through a logistic whose scale widens early (a lead
 *    is worth less with lots of time left) and tightens late (a small lead
 *    late is nearly decisive). Overtime collapses to a near-coin-flip band.
 *  - O/U: the NFL slate carries no total line, so we project a final combined
 *    total from current score + league scoring rate over remaining time.
 *
 * Deterministic — no Monte Carlo, so it never flickers between polls.
 */
import { timeRemainingMin } from './live.js';

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Parse an ESPN record summary like "12-4" or "12-4-1" into {w,l,t}. */
function parseRecord(summary) {
  if (!summary) return null;
  const m = String(summary).trim().match(/^(\d+)\s*-\s*(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return null;
  return { w: +m[1], l: +m[2], t: m[3] != null ? +m[3] : 0 };
}

/**
 * Pre-game win prior for the away team. Uses de-vigged American-odds implied
 * probability when moneyline odds are attached; otherwise shrinks each team's
 * record win percentage toward .500 (with a home-field nudge for the home team)
 * and combines. Clamped to [0.30, 0.70] so a single bad record can't dominate.
 */
export function pregameAwayProb(game) {
  // 1. Moneyline, if the slate ever carries it.
  const ao = game.awayOdds != null ? Number(game.awayOdds) : NaN;
  const ho = game.homeOdds != null ? Number(game.homeOdds) : NaN;
  if (Number.isFinite(ao) && ao !== 0 && Number.isFinite(ho) && ho !== 0) {
    const a = ao > 0 ? 100 / (ao + 100) : (-ao) / (-ao + 100);
    const h = ho > 0 ? 100 / (ho + 100) : (-ho) / (-ho + 100);
    if (a + h > 0) return clamp(a / (a + h), 0.30, 0.70);
  }
  // 2. Records, shrunk heavily (Add 2 wins + a tie's worth, 4 games of prior).
  const recAway = parseRecord((game.away?.records || []).find(r => r.type === 'total')?.summary);
  const recHome = parseRecord((game.home?.records || []).find(r => r.type === 'total')?.summary);
  const wp = (r) => r ? (r.w + 0.5 * r.t + 2) / (r.w + r.l + r.t + 4) : 0.5;
  const awayWP = wp(recAway), homeWP = wp(recHome);
  // Logit-difference with a small home-field edge (~0.12 in logit space).
  const p = sigmoid(0.75 * (logit(awayWP) - logit(homeWP)) - 0.12);
  return clamp(p, 0.30, 0.70);
}

/**
 * Expected points for the team currently with the ball, from field position.
 * `yardFromOwn` is yards from the possessing team's own goal line (0-100).
 * Falls back to a neutral drive value when field position is unknown.
 */
function possessionEP(yardFromOwn, isRedZone, remMin) {
  let ep;
  if (yardFromOwn != null && Number.isFinite(yardFromOwn)) {
    ep = clamp(-0.8 + 0.06 * yardFromOwn, -0.8, 5.2);
  } else if (isRedZone) {
    ep = 3.5;
  } else {
    ep = 0.8;
  }
  // Damp toward zero when there isn't enough time for a full drive (~2min floor).
  return ep * clamp(remMin / 2.0, 0, 1);
}

/**
 * Live win probability. Returns { awayPct, homePct, projTotal }.
 *  - awayPct/homePct sum to 1.
 *  - projTotal: projected final combined score (shown in the O/U tile since the
 *    NFL slate has no total line).
 */
export function liveWinProb(game) {
  const away = game.away || {}, home = game.home || {};
  const awayScore = Number(away.score) || 0;
  const homeScore = Number(home.score) || 0;
  const status = game.status || '';
  const ls = game.liveScore || {};
  const pAwayPre = pregameAwayProb(game);

  // Final → winner takes all (a tie resolves to the pre-game prior).
  if (status === 'post' || /Final|Game Over/i.test(game.statusDetail || '')) {
    const dec = awayScore === homeScore ? pAwayPre : (awayScore > homeScore ? 1 : 0);
    return { awayPct: dec, homePct: 1 - dec, projTotal: null };
  }
  // Not started → pre-game prior; project a neutral total from the full game.
  if (status === 'pre' || !ls.period || ls.period < 1) {
    const proj = awayScore + homeScore + 0.74 * 60;
    return { awayPct: pAwayPre, homePct: 1 - pAwayPre, projTotal: proj };
  }

  const isOT = ls.period >= 5;
  const remMin = timeRemainingMin(ls.period, ls.clockMin);
  const timeNorm = clamp(remMin / (isOT ? 10 : 60), 0, 1);

  // Scale of the logistic: wide early (leads are fragile), tight late, and a
  // narrow band in overtime where anything can happen.
  const scale = isOT ? 2.0 + 7.0 * Math.pow(timeNorm, 0.70)
    : 2.0 + 12.0 * Math.pow(timeNorm, 0.70);

  // Strength-prior edge, decaying as time runs out. In overtime a tie is near a
  // coin flip, so the pre-game prior barely matters there — damp it hard.
  const priorEdge = isOT
    ? logit(pAwayPre) * 1.5 * Math.sqrt(timeNorm)
    : logit(pAwayPre) * scale * Math.sqrt(timeNorm);

  // Possession edge (away's perspective): +EP if away has the ball, -EP if home does.
  const ep = possessionEP(ls.yardFromOwn, ls.isRedZone, remMin);
  const possessionEdge = ls.possession === 'away' ? +ep
    : ls.possession === 'home' ? -ep : 0;

  const awayLead = awayScore - homeScore;
  const edge = awayLead + priorEdge + possessionEdge;

  const awayPct = clamp(sigmoid(edge / scale), 0.005, 0.995);
  const homePct = 1 - awayPct;

  // Projected final combined total: current score + league combined rate * rem time.
  const projTotal = (awayScore + homeScore) + 0.74 * remMin;
  return { awayPct, homePct, projTotal };
}
