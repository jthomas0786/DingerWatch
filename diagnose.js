#!/usr/bin/env node
/**
 * diagnose.js — answers "why did my slate come out wrong?" without touching
 * any of the build logic. Prints exactly what MLB's schedule endpoint returns
 * for a given date, alongside every date the system might have meant.
 *
 *   node diagnose.js              # today (US Eastern) + neighbours
 *   node diagnose.js 2026-08-09   # a specific date
 */
const MLB = 'https://statsapi.mlb.com/api/v1';

const easternToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const shift = (d, n) => {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

async function probe(date) {
  const url = `${MLB}/schedule?sportId=1&date=${date}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return console.log(`  ${date}  HTTP ${res.status}`);
    const d = await res.json();
    const games = (d.dates || []).flatMap(x => x.games || []);
    if (!games.length) return console.log(`  ${date}  no games`);
    const st = games.reduce((a, g) => {
      const k = g.status?.abstractGameState || '?';
      a[k] = (a[k] || 0) + 1; return a;
    }, {});
    console.log(`  ${date}  ${games.length} games  ${JSON.stringify(st)}`);
    games.slice(0, 3).forEach(g =>
      console.log(`      ${g.teams.away.team.abbreviation}@${g.teams.home.team.abbreviation} ` +
                  `${g.gameDate} [${g.status?.abstractGameState}]`));
    if (games.length > 3) console.log(`      … +${games.length - 3} more`);
  } catch (e) {
    console.log(`  ${date}  FETCH FAILED: ${e.message}`);
  }
}

const target = process.argv[2] || easternToday();
console.log('Clock context');
console.log('  UTC now          :', new Date().toISOString());
console.log('  UTC date         :', new Date().toISOString().slice(0, 10), '  ← what the OLD code used');
console.log('  US Eastern date  :', easternToday(), '  ← what the FIXED code uses');
console.log('  Runner local     :', Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('\nSchedule around', target);
for (const d of [shift(target, -1), target, shift(target, 1)]) await probe(d);
console.log('\nIf the target date shows all-Final games, the build ran for a past date.');
console.log('If it shows only a few games, that date genuinely had a light slate.');
