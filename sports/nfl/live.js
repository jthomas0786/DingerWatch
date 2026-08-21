/**
 * sports/nfl/live.js — in-browser live-score merge for the NFL gamecast.
 *
 * ESPN's scoreboard site API blocks browser fetches (any browser User-Agent
 * gets a 403), so the client can't poll ESPN directly the way the MLB view polls
 * statsapi.mlb.com. Instead the browser fetches a small same-origin file —
 * slates/nfl-live.json — produced server-side by an Actions poller
 * (see .github/workflows/nfl-live.yml) that hits ESPN with a server User-Agent
 * (which ESPN serves fine). Same-origin, so no CORS, no console errors.
 *
 * Fail-soft: if the file is missing or stale (e.g. no live games right now, or
 * the poller hasn't run yet), the gamecast keeps showing the build-time scores
 * + pre-game win probability from the slate. Nothing breaks.
 */

const POLL_MS = 15000; // 15s — frequent enough to catch a drive, gentle on Pages CDN
const LIVE_URL = 'slates/nfl-live.json';

let _slate = null;
let _onChange = null;      // () => void — called after a merge that changed something
let _timer = null;
let _inflight = false;
let _lastSig = {};        // gameId -> signature string

/**
 * Pull the live fields for one game out of the poller's compact JSON.
 * Shared with the server-side poller so the mapping lives in one place —
 * the poller imports this and writes the file in the same shape it reads.
 */
export function extractLive(event) {
  const comp = event.competitions && event.competitions[0];
  if (!comp) return null;
  const status = comp.status || {};
  const type = status.type || {};
  const state = type.state; // pre | in | post
  const comps = comp.competitors || [];
  const home = comps.find(c => c.homeAway === 'home') || comps[0];
  const away = comps.find(c => c.homeAway === 'away') || comps[1];
  if (!home || !away) return null;

  const clockMin = parseClock(status.displayClock || status.shortClock);
  const period = status.period || 0;
  const sit = comp.situation;
  let possession = null;       // 'away' | 'home' | null
  let yardFromOwn = null;      // yards from possessing team's own goal line (0-100)
  let isRedZone = false;
  if (sit && state === 'in') {
    const possId = sit.possession; // ESPN team id of the team with the ball
    if (possId != null) {
      if (String(home.team?.id) === String(possId)) possession = 'home';
      else if (String(away.team?.id) === String(possId)) possession = 'away';
    }
    isRedZone = !!sit.isRedZone;
    const bl = sit.ballLocation;
    if (bl && Number.isFinite(bl.yardLine) && bl.team && bl.team.id != null) {
      // yardLine is 0-100 from the possessing team's own goal line.
      const possOwnsBall = String(bl.team.id) === String(possId);
      yardFromOwn = possOwnsBall ? bl.yardLine : (100 - bl.yardLine);
      if (!possOwnsBall) isRedZone = yardFromOwn >= 80; // deep in opponent territory
    }
  }

  return {
    status: state,
    statusDetail: type.shortDetail || (type.completed ? type.shortDetail : null),
    period,
    clockMin,
    awayScore: away.score != null ? Number(away.score) : null,
    homeScore: home.score != null ? Number(home.score) : null,
    possession,
    yardFromOwn,
    isRedZone,
    lastFetchedAt: Date.now(),
  };
}

function parseClock(displayClock) {
  if (!displayClock || typeof displayClock !== 'string') return null;
  const parts = displayClock.split(':');
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    const s = parseInt(parts[1], 10);
    if (Number.isFinite(m) && Number.isFinite(s)) return m + s / 60;
  }
  const n = parseFloat(displayClock);
  return Number.isFinite(n) ? n : null;
}

function sig(live) {
  if (!live) return '';
  return [live.status, live.awayScore, live.homeScore, live.period, live.clockMin && live.clockMin.toFixed(2),
    live.possession, live.yardFromOwn != null ? Math.round(live.yardFromOwn) : '', live.isRedZone ? 1 : 0].join('|');
}

async function tick() {
  if (_inflight || !_slate) return;
  _inflight = true;
  try {
    const res = await fetch(LIVE_URL, { cache: 'no-store' });
    if (!res.ok) return; // 404 (no live file yet) → keep showing the slate
    const data = await res.json();
    const live = data && data.games ? data.games : {};
    let changed = false;
    for (const g of (_slate.games || [])) {
      const gl = live[String(g.gameId)];
      if (!gl) continue;
      const s = sig(gl);
      if (s && _lastSig[g.gameId] !== s) {
        g.status = gl.status || g.status;
        g.statusDetail = gl.statusDetail || g.statusDetail;
        g.away = { ...(g.away || {}), score: gl.awayScore != null ? gl.awayScore : (g.away?.score ?? 0) };
        g.home = { ...(g.home || {}), score: gl.homeScore != null ? gl.homeScore : (g.home?.score ?? 0) };
        g.liveScore = {
          period: gl.period, clockMin: gl.clockMin,
          possession: gl.possession, yardFromOwn: gl.yardFromOwn, isRedZone: gl.isRedZone,
          lastFetchedAt: gl.lastFetchedAt || data.lastFetchedAt,
        };
        _lastSig[g.gameId] = s;
        changed = true;
      }
    }
    if (changed && typeof _onChange === 'function') _onChange();
  } catch (_e) {
    // Missing/invalid file or network failure — leave last-known state; next tick retries.
  } finally {
    _inflight = false;
  }
}

/** True if any game on the slate is live or about to start (polling is pointless otherwise). */
function shouldPoll() {
  if (!_slate) return false;
  const now = Date.now();
  return (_slate.games || []).some(g => {
    if (g.status === 'in') return true;
    // Start polling ~30min before kickoff so the gamecast is live the moment it begins.
    if (g.status === 'pre' && g.startTimeUTC) {
      const t = new Date(g.startTimeUTC).getTime();
      return Number.isFinite(t) && t - now < 30 * 60000 && t - now > -3 * 3600000;
    }
    return false;
  });
}

export function startLivePolling(slate, onChange) {
  _slate = slate;
  _onChange = onChange || null;
  if (_timer) clearInterval(_timer);
  tick();
  _timer = setInterval(() => {
    if (shouldPoll()) tick();
  }, POLL_MS);
}

export function stopLivePolling() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _slate = null; _onChange = null; _lastSig = {};
}

/**
 * Whole-game minutes remaining from period + clock. ESPN's clock is the time
 * left IN the current period; the rest of regulation is (4 - period) more full
 * quarters. Overtime is treated as a short ~10-minute tail.
 */
export function timeRemainingMin(period, clockMin) {
  if (!period || period < 1) return 60;          // pre-game
  if (period >= 5) {                             // overtime
    if (clockMin == null || clockMin < 0) return 10;
    return Math.min(10, Math.max(0, clockMin));
  }
  const inQuarter = clockMin == null ? 15 : Math.max(0, Math.min(15, clockMin));
  return (4 - period) * 15 + inQuarter;
}
