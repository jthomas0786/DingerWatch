#!/usr/bin/env node
/**
 * build-slate.js — assembles the full daily MLB slate into a single slate.json
 *
 * Run this on a schedule (cron / GitHub Actions). The browser then makes exactly
 * ONE same-origin request for slate.json instead of ~50 cross-origin requests,
 * which sidesteps CORS/CSP blocking entirely and loads far faster.
 *
 * Everything here is fetched live from the MLB Stats API + Open-Meteo, so the
 * whole class of "stale hardcoded stat" bugs disappears: HR totals, rosters,
 * probable pitchers, and trade/injury moves all self-correct every morning.
 *
 * Usage:
 *   node build-slate.js                  # today
 *   node build-slate.js --date 2026-08-10
 *   node build-slate.js --out public/slate.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const MLB = 'https://statsapi.mlb.com/api/v1';
const MLB11 = 'https://statsapi.mlb.com/api/v1.1';
const SEASON = new Date().getFullYear();

// ---------------------------------------------------------------- CLI args
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
// MLB's "game date" follows US convention: a 10pm ET game belongs to that
// calendar day, not the next UTC day. Defaulting to the UTC date meant any run
// after ~7pm ET built TOMORROW's slate — and any run in the early UTC hours
// could build yesterday's. Anchor to US Eastern instead.
function todayEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());   // en-CA gives YYYY-MM-DD
}
const DATE = arg('--date', todayEastern());
const VERBOSE = process.argv.includes('--verbose');
const OUT = arg('--out', 'public/slate.json');
const CONCURRENCY = 6; // be a polite API citizen

// ---------------------------------------------------------------- utilities
async function getJSON(url, { retries = 3, timeoutMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'dinger-watch-slate-builder/1.0' },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw new Error(`${url} failed after ${retries} tries: ${err.message}`);
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt)); // backoff
    }
  }
}

/** Run async fn over items with bounded concurrency. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try { out[i] = await fn(items[i], i); }
        catch (err) { out[i] = { __error: err.message }; }
      }
    })
  );
  return out;
}

const num = v => (v === undefined || v === null || v === '-.--' || v === '' ? null : Number(v));
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : +v.toFixed(d));

// ---------------------------------------------------------------- schedule
async function fetchSchedule(date) {
  const url = `${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,venue,team`;
  if (VERBOSE) console.log(`  GET ${url}`);
  const data = await getJSON(url);

  // Flatten across every returned date bucket rather than assuming one. The API
  // can split entries, and silently reading only dates[0] would drop games.
  const allGames = (data.dates || []).flatMap(d => d.games || []);
  if (VERBOSE) {
    console.log(`  API returned ${data.totalGames ?? '?'} totalGames across ${(data.dates || []).length} date bucket(s)`);
    (data.dates || []).forEach(d => console.log(`    ${d.date}: ${d.games?.length ?? 0} games`));
  }
  if (!allGames.length) return [];

  // Guard against a date mismatch — if the API hands back a different day than
  // we asked for, that's the single most likely cause of a "wrong slate" bug,
  // so surface it loudly instead of silently building the wrong thing.
  const offDate = (data.dates || []).filter(d => d.date !== date).map(d => d.date);
  if (offDate.length) {
    console.warn(`  ⚠ requested ${date} but API also returned: ${offDate.join(', ')}`);
  }

  return allGames.map(g => ({
    gamePk: g.gamePk,
    startTimeUTC: g.gameDate,
    status: g.status?.abstractGameState || 'Preview',
    detailedStatus: g.status?.detailedState || null,
    doubleHeader: g.doubleHeader !== 'N',
    gameNumber: g.gameNumber || 1,
    venueId: String(g.venue?.id ?? ''),
    venueName: g.venue?.name ?? null,
    away: {
      id: g.teams.away.team.id,
      abbr: g.teams.away.team.abbreviation,
      name: g.teams.away.team.teamName,
      probablePitcherId: g.teams.away.probablePitcher?.id ?? null,
      probablePitcherName: g.teams.away.probablePitcher?.fullName ?? null,
    },
    home: {
      id: g.teams.home.team.id,
      abbr: g.teams.home.team.abbreviation,
      name: g.teams.home.team.teamName,
      probablePitcherId: g.teams.home.probablePitcher?.id ?? null,
      probablePitcherName: g.teams.home.probablePitcher?.fullName ?? null,
    },
  }));
}

// ---------------------------------------------------------------- rosters
/**
 * Active roster = who can actually play today. Comparing against the 40-man
 * surfaces who's on the IL / optioned, so injured players drop out automatically
 * instead of needing to be hand-removed.
 */
async function fetchTeamRoster(teamId) {
  const [active, full] = await Promise.all([
    getJSON(`${MLB}/teams/${teamId}/roster?rosterType=active&season=${SEASON}`).catch(() => ({ roster: [] })),
    getJSON(`${MLB}/teams/${teamId}/roster?rosterType=40Man&season=${SEASON}`).catch(() => ({ roster: [] })),
  ]);
  const activeIds = new Set((active.roster || []).map(p => p.person.id));
  return {
    active: (active.roster || []).map(p => ({
      id: p.person.id,
      name: p.person.fullName,
      pos: p.position?.abbreviation ?? null,
      posType: p.position?.type ?? null,
    })),
    inactiveIds: (full.roster || [])
      .filter(p => !activeIds.has(p.person.id))
      .map(p => p.person.id),
  };
}

// ---------------------------------------------------------------- player stats
async function fetchHittingStats(playerId) {
  const url = `${MLB}/people/${playerId}/stats?stats=season&group=hitting&season=${SEASON}&gameType=R`;
  const data = await getJSON(url);
  const s = data.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    g: num(s.gamesPlayed), pa: num(s.plateAppearances), ab: num(s.atBats),
    h: num(s.hits), r: num(s.runs), hr: num(s.homeRuns), rbi: num(s.rbi), sb: num(s.stolenBases),
    bb: num(s.baseOnBalls), so: num(s.strikeOuts),
    avg: num(s.avg), obp: num(s.obp), slg: num(s.slg), ops: num(s.ops),
  };
}

async function fetchPitchingStats(playerId) {
  const url = `${MLB}/people/${playerId}/stats?stats=season&group=pitching&season=${SEASON}&gameType=R`;
  const data = await getJSON(url);
  const s = data.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  const ip = parseIP(s.inningsPitched);
  return {
    gs: num(s.gamesStarted), ip,
    era: num(s.era), whip: num(s.whip),
    k: num(s.strikeOuts), bb: num(s.baseOnBalls), hr: num(s.homeRuns),
    // Derived rates — these are what the HR/K models actually consume.
    k9: ip ? round((num(s.strikeOuts) * 9) / ip, 2) : null,
    bb9: ip ? round((num(s.baseOnBalls) * 9) / ip, 2) : null,
    hr9: ip ? round((num(s.homeRuns) * 9) / ip, 2) : null,
  };
}

/** MLB reports IP as "142.1" meaning 142 and 1/3 innings — not 142.1 decimal. */
function parseIP(ipStr) {
  if (!ipStr) return null;
  const [whole, frac] = String(ipStr).split('.');
  return Number(whole) + (frac === '1' ? 1 / 3 : frac === '2' ? 2 / 3 : 0);
}

/** Recent form: last 10 game logs, used for hot/cold trend. */
async function fetchLast10(playerId) {
  const url = `${MLB}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${SEASON}&gameType=R`;
  const data = await getJSON(url).catch(() => null);
  const splits = data?.stats?.[0]?.splits ?? [];
  const last = splits.slice(-10).map(s => ({
    date: s.date,
    opp: s.opponent?.abbreviation ?? null,
    ab: num(s.stat.atBats), h: num(s.stat.hits),
    r: num(s.stat.runs), hr: num(s.stat.homeRuns), rbi: num(s.stat.rbi),
  }));
  const ab = last.reduce((t, g) => t + (g.ab || 0), 0);
  const h = last.reduce((t, g) => t + (g.h || 0), 0);
  const hr = last.reduce((t, g) => t + (g.hr || 0), 0);
  return { games: last, totals: { ab, h, hr, avg: ab ? round(h / ab, 3) : null } };
}

// ---------------------------------------------------------------- weather
const VENUE_COORDS = {}; // filled from schedule venue lookup + parks.json fallback

async function fetchVenueCoords(venueId) {
  const data = await getJSON(`${MLB}/venues/${venueId}?hydrate=location`).catch(() => null);
  const loc = data?.venues?.[0]?.location?.defaultCoordinates;
  return loc ? { lat: loc.latitude, lon: loc.longitude } : null;
}

async function fetchWeatherAt(lat, lon, startTimeUTC) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,`
    + `wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`
    + `&forecast_days=3&timezone=UTC`;
  const data = await getJSON(url);
  const target = new Date(startTimeUTC).toISOString().slice(0, 13) + ':00';
  const idx = data.hourly.time.indexOf(target);
  const i = idx > -1 ? idx : 0;
  return {
    tempF: round(data.hourly.temperature_2m[i], 0),
    humidity: round(data.hourly.relative_humidity_2m[i], 0),
    dewPoint: round(data.hourly.dew_point_2m[i], 0),
    precipChance: round(data.hourly.precipitation_probability[i], 0),
    windMph: round(data.hourly.wind_speed_10m[i], 0),
    windDeg: round(data.hourly.wind_direction_10m[i], 0),
    forecastHourUTC: data.hourly.time[i],
  };
}

/** Translate raw compass wind into baseball terms relative to the field. */
function windRelativeToPark(windFromDeg, cfBearing) {
  if (windFromDeg == null || cfBearing == null) return null;
  const blowTo = (windFromDeg + 180) % 360;
  const rel = ((blowTo - cfBearing + 540) % 360) - 180;
  const a = Math.abs(rel);
  let label, sector;
  if (a <= 22.5) { label = 'Out to center'; sector = 'out'; }
  else if (rel > 22.5 && rel <= 67.5) { label = 'Out to right field'; sector = 'out'; }
  else if (rel < -22.5 && rel >= -67.5) { label = 'Out to left field'; sector = 'out'; }
  else if (a > 157.5) { label = 'In from center'; sector = 'in'; }
  else if (rel > 112.5) { label = 'In from right field'; sector = 'in'; }
  else if (rel < -112.5) { label = 'In from left field'; sector = 'in'; }
  else { label = rel > 0 ? 'Across toward 1B side' : 'Across toward 3B side'; sector = 'across'; }
  return { label, sector, relativeDeg: round(rel, 0) };
}

// ---------------------------------------------------------------- assembly
async function build() {
  const started = Date.now();
  const warnings = [];
  console.log(`▸ Building slate for ${DATE}  (US Eastern today = ${todayEastern()}, UTC now = ${new Date().toISOString()})`);

  const parks = JSON.parse(await fs.readFile(new URL('./parks.json', import.meta.url), 'utf8'));

  // 1. Schedule
  const schedule = await fetchSchedule(DATE);
  if (!schedule.length) {
    console.log('  no games scheduled');
    await writeOut({ date: DATE, generatedAt: new Date().toISOString(), games: [], warnings: ['No games scheduled'] });
    return;
  }
  const statusCounts = schedule.reduce((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1; return acc;
  }, {});
  console.log(`  ${schedule.length} games — ${Object.entries(statusCounts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  if (schedule.length && schedule.every(g => g.status === 'Final')) {
    warnings.push(`Every game for ${DATE} is already Final — check that the build ran for the intended date (system UTC now: ${new Date().toISOString()})`);
    console.warn('  ⚠ all games already Final — is this the date you meant?');
  }
  if (VERBOSE) {
    schedule.forEach(g => console.log(`    ${g.away.abbr}@${g.home.abbr} ${g.startTimeUTC} [${g.status}]`));
  }

  // 2. Rosters (unique teams only)
  const teamIds = [...new Set(schedule.flatMap(g => [g.away.id, g.home.id]))];
  const rosterList = await mapLimit(teamIds, CONCURRENCY, fetchTeamRoster);
  const rosters = Object.fromEntries(teamIds.map((id, i) => [id, rosterList[i]]));
  console.log(`  ${teamIds.length} team rosters`);

  // 3. Hitter stats — only position players on active rosters
  const hitters = [];
  for (const teamId of teamIds) {
    const r = rosters[teamId];
    if (!r || r.__error) { warnings.push(`roster fetch failed for team ${teamId}`); continue; }
    for (const p of r.active) {
      if (p.posType === 'Pitcher') continue;
      hitters.push({ ...p, teamId });
    }
  }
  console.log(`  ${hitters.length} hitters — fetching season stats`);
  const hitterStats = await mapLimit(hitters, CONCURRENCY, h => fetchHittingStats(h.id));

  // Keep only hitters with enough PA to be meaningful, then attach last-10 form.
  const qualified = hitters
    .map((h, i) => ({ ...h, stats: hitterStats[i] }))
    .filter(h => h.stats && h.stats.pa >= 50);
  console.log(`  ${qualified.length} qualified (50+ PA) — fetching recent form`);
  const forms = await mapLimit(qualified, CONCURRENCY, h => fetchLast10(h.id));
  qualified.forEach((h, i) => { h.recent = forms[i]?.__error ? null : forms[i]; });

  const byTeam = {};
  for (const h of qualified) (byTeam[h.teamId] ||= []).push(h);

  // 4. Probable pitchers
  const pitcherIds = [...new Set(schedule.flatMap(g =>
    [g.away.probablePitcherId, g.home.probablePitcherId]).filter(Boolean))];
  console.log(`  ${pitcherIds.length} probable starters announced`);
  const pStats = await mapLimit(pitcherIds, CONCURRENCY, fetchPitchingStats);
  const pitcherMap = Object.fromEntries(pitcherIds.map((id, i) => [id, pStats[i]]));
  const unannounced = schedule.filter(g => !g.away.probablePitcherId || !g.home.probablePitcherId).length;
  if (unannounced) warnings.push(`${unannounced} game(s) missing a probable starter — normal this far out`);

  // 5. Venue coords + weather
  const venueIds = [...new Set(schedule.map(g => g.venueId))];
  const coordList = await mapLimit(venueIds, CONCURRENCY, fetchVenueCoords);
  const coords = Object.fromEntries(venueIds.map((id, i) => [id, coordList[i]]));

  const weatherList = await mapLimit(schedule, CONCURRENCY, async g => {
    const park = parks.venues[g.venueId];
    const c = coords[g.venueId];
    if (!c) return null;
    // Indoor parks: skip the fetch, wind is irrelevant.
    if (park && park.roof === 'fixed') return { indoor: true };
    const w = await fetchWeatherAt(c.lat, c.lon, g.startTimeUTC);
    return { ...w, wind: windRelativeToPark(w.windDeg, park?.cfBearing) };
  });
  console.log(`  weather for ${venueIds.length} venues`);

  // 6. Assemble
  const games = schedule.map((g, i) => {
    const park = parks.venues[g.venueId] || null;
    if (!park) warnings.push(`no park data for venue ${g.venueId} (${g.venueName})`);
    const weather = weatherList[i]?.__error ? null : weatherList[i];

    const mkPitcher = side => {
      const id = g[side].probablePitcherId;
      if (!id) return null;
      const s = pitcherMap[id];
      return {
        id, name: g[side].probablePitcherName,
        confirmed: true,
        stats: s && !s.__error ? s : null,
      };
    };

    const mkLineup = teamId => (byTeam[teamId] || [])
      .sort((a, b) => (b.stats.ops ?? 0) - (a.stats.ops ?? 0))
      .slice(0, 12)
      .map(h => ({
        id: h.id, name: h.name, pos: h.pos,
        season: h.stats,
        last10: h.recent?.totals ?? null,
        gameLog: h.recent?.games ?? [],
      }));

    return {
      gamePk: g.gamePk,
      startTimeUTC: g.startTimeUTC,
      status: g.status,
      detailedStatus: g.detailedStatus,
      doubleHeader: g.doubleHeader,
      gameNumber: g.gameNumber,
      venue: { id: g.venueId, name: g.venueName, ...(park || {}) },
      weather,
      away: { ...g.away, pitcher: mkPitcher('away'), lineup: mkLineup(g.away.id) },
      home: { ...g.home, pitcher: mkPitcher('home'), lineup: mkLineup(g.home.id) },
    };
  });

  const payload = {
    date: DATE,
    generatedAt: new Date().toISOString(),
    builtForEasternDate: todayEastern(),
    buildDurationMs: Date.now() - started,
    gameCount: games.length,
    sources: {
      schedule: 'MLB Stats API', rosters: 'MLB Stats API',
      playerStats: 'MLB Stats API', weather: 'Open-Meteo',
      parkFactors: 'static parks.json (manually maintained)',
      statcast: 'NOT INCLUDED — see enrich-statcast.py',
      odds: 'NOT INCLUDED — requires a paid feed (e.g. The-Odds-API)',
    },
    warnings,
    games,
  };

  await writeOut(payload);
  console.log(`✓ ${games.length} games → ${OUT} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (warnings.length) console.log(`  ${warnings.length} warning(s):`), warnings.forEach(w => console.log(`    · ${w}`));
}

async function writeOut(payload) {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
}

build().catch(err => {
  console.error('✗ build failed:', err.message);
  // Non-zero exit so CI surfaces it — but the previously committed slate.json
  // stays in place, so the site degrades to yesterday's data rather than nothing.
  process.exit(1);
});
