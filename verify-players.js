#!/usr/bin/env node
/**
 * verify-players.js — checks which active hitters made it into slate.json, and
 * explains why anyone missing was dropped.
 *
 * Players can disappear for several reasons, none of which are visible from the
 * site itself. This compares the slate against MLB's live active rosters and
 * names the cause for each gap.
 *
 *   node verify-players.js                          # full report
 *   node verify-players.js --player "Jarren Duran"  # trace one player
 *   node verify-players.js --team BOS               # one team
 */

import fs from 'node:fs/promises';

const MLB = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();

const arg = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SLATE = arg('--slate', 'public/slate.json');
const ONE_PLAYER = arg('--player');
const ONE_TEAM = arg('--team');

const norm = n => String(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'dinger-watch-verify/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const slate = JSON.parse(await fs.readFile(SLATE, 'utf8'));
  console.log(`\n▸ verifying ${SLATE} (${slate.date}, ${slate.games.length} games)\n`);

  // Everyone the slate actually contains.
  const inSlate = new Map();
  for (const g of slate.games) {
    for (const side of ['away', 'home']) {
      for (const h of g[side].lineup || []) {
        inSlate.set(h.id, { ...h, team: g[side].abbr });
      }
    }
  }
  console.log(`  slate contains ${inSlate.size} hitters`);

  let totalActive = 0, missing = [];

  for (const g of slate.games) {
    for (const side of ['away', 'home']) {
      const team = g[side];
      if (ONE_TEAM && team.abbr !== ONE_TEAM.toUpperCase()) continue;

      let roster;
      try {
        roster = await getJSON(`${MLB}/teams/${team.id}/roster?rosterType=active&season=${SEASON}`);
      } catch (e) {
        console.warn(`  ! roster fetch failed for ${team.abbr}: ${e.message}`);
        continue;
      }

      const hitters = (roster.roster || []).filter(p => p.position?.type !== 'Pitcher');
      totalActive += hitters.length;

      for (const p of hitters) {
        if (inSlate.has(p.person.id)) continue;

        // Not in the slate — find out why.
        let reason = 'unknown';
        try {
          const st = await getJSON(
            `${MLB}/people/${p.person.id}/stats?stats=season&group=hitting&season=${SEASON}&gameType=R`);
          const s = st.stats?.[0]?.splits?.[0]?.stat;
          if (!s) reason = 'no season hitting stats (has not batted this year)';
          else if ((s.plateAppearances ?? 0) < 15) reason = `only ${s.plateAppearances} PA (under the minimum)`;
          else reason = `${s.plateAppearances} PA — cut by the per-team cap`;
        } catch { reason = 'stats lookup failed'; }

        missing.push({ name: p.person.fullName, team: team.abbr,
                       pos: p.position?.abbreviation ?? '?', id: p.person.id, reason });
      }
    }
  }

  // Single-player trace.
  if (ONE_PLAYER) {
    const target = norm(ONE_PLAYER);
    const found = [...inSlate.values()].find(h => norm(h.name) === target);
    console.log(`\n── ${ONE_PLAYER} ──`);
    if (found) {
      console.log(`  IN THE SLATE`);
      console.log(`    team          ${found.team}`);
      console.log(`    id            ${found.id}`);
      console.log(`    position      ${found.pos}`);
      console.log(`    batting order ${found.battingOrder ?? 'not posted yet'}`);
      console.log(`    PA            ${found.season?.pa ?? '?'}`);
      console.log(`    line          ${found.season?.hr ?? '?'} HR, .${String(Math.round((found.season?.avg ?? 0)*1000)).padStart(3,'0')} AVG`);
    } else {
      const m = missing.find(x => norm(x.name) === target);
      if (m) {
        console.log(`  MISSING — ${m.reason}`);
        console.log(`    team ${m.team} · id ${m.id} · ${m.pos}`);
      } else {
        console.log(`  not on any active roster for today's games`);
        console.log(`  (injured list, minors, or his team isn't playing)`);
      }
    }
    console.log('');
    return;
  }

  console.log(`  ${totalActive} active hitters across today's rosters`);
  console.log(`  ${totalActive - missing.length} present · ${missing.length} missing\n`);

  if (!missing.length) { console.log('✓ every active hitter is in the slate\n'); return; }

  // Group by cause so the report is readable.
  const byReason = {};
  for (const m of missing) {
    const key = m.reason.includes('cap') ? 'cut by the per-team cap'
              : m.reason.includes('PA') ? 'below the PA minimum'
              : m.reason;
    (byReason[key] ||= []).push(m);
  }
  for (const [reason, list] of Object.entries(byReason)) {
    console.log(`  ${reason} — ${list.length}`);
    for (const m of list.slice(0, 25)) console.log(`    · ${m.team} ${m.name} (${m.pos})`);
    if (list.length > 25) console.log(`    · …and ${list.length - 25} more`);
    console.log('');
  }

  if (byReason['cut by the per-team cap']?.length) {
    console.log('  Raise the cap to include them:  node build-slate.js --lineup-cap 26\n');
  }
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
