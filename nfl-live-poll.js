#!/usr/bin/env node
/**
 * nfl-live-poll.js — server-side live-score poller for the NFL gamecast.
 *
 * Runs inside .github/workflows/nfl-live.yml as a long-lived job during NFL
 * game windows. Polls ESPN's scoreboard every 30s with a SERVER User-Agent
 * (ESPN 403s any browser UA), extracts the live fields each gamecast needs
 * via the SAME extractLive() the browser client uses (so the mapping lives in
 * one place — sports/nfl/live.js), and writes slates/nfl-live.json.
 *
 * Commits only when a score/state actually changed (signature compare over the
 * meaningful fields only — NOT lastFetchedAt, which changes every tick and
 * would otherwise force a commit every 30s). A typical game produces ~10–20
 * commits, not ~700. Fail-soft: a single bad tick is logged and skipped; the
 * loop keeps going until the slate wraps up.
 *
 * The browser never hits ESPN — it polls this same-origin file every 15s.
 */
import { extractLive } from './sports/nfl/live.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const OUT = 'slates/nfl-live.json';
const UA = 'okhttp/4.12.0'; // ESPN allowlists known HTTP-library UAs (curl, okhttp, Python-urllib) and 403s browser/custom UAs.
const POLL_MS = Number(process.env.POLL_MS) || 30000;
const MAX_TICKS = Number(process.env.MAX_TICKS) || 0; // 0 = until slate done / timeout

function git(args) {
  try {
    return execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(`git ${args.join(' ')} failed: ${(e.stderr || e.message || '').slice(0, 200)}`);
  }
}

async function fetchScoreboard() {
  const res = await fetch(ESPN_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

/**
 * Signature over the DISCRETE state that drives the gamecast — status, scores,
 * period, possession, red-zone. Excludes clockMin and yardFromOwn (which drift
 * on every play and would force a commit every 30s → ~720/game). Those fields
 * are still written to the file (so the tiles can use them), they just don't
 * trigger a commit by themselves. This is what keeps a game at ~20–40 commits.
 */
function signature(games) {
  const parts = [];
  for (const id of Object.keys(games).sort()) {
    const g = games[id];
    parts.push(id + ':' + [g.status, g.awayScore, g.homeScore, g.period,
      g.possession || '', g.isRedZone ? 1 : 0].join('|'));
  }
  return parts.join('::');
}

let lastSig = '';

function commitIfChanged(games) {
  const sig = signature(games);
  if (sig === lastSig) return false; // no score/state change since last commit
  lastSig = sig;
  const payload = { lastFetchedAt: new Date().toISOString(), games };
  const json = JSON.stringify(payload, null, 2);
  if (!existsSync('slates')) execFileSync('mkdir', ['-p', 'slates']);
  writeFileSync(OUT, json + '\n');
  git(['config', 'user.name', 'nfl-live-bot']);
  git(['config', 'user.email', 'actions@github.com']);
  git(['add', OUT]);
  git(['commit', '-m', `nfl live: score update ${new Date().toISOString().slice(11, 19)}Z`]);
  // push.yml auto-commits every few minutes, so the checkout can go stale
  // mid-tick. Rebase onto whatever arrived and retry (same pattern as nfl-slate).
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { git(['push']); return true; }
    catch (_) {
      git(['pull', '--rebase', '--autostash', 'origin', process.env.GITHUB_REF_NAME || 'public']);
    }
  }
  console.error('::warning::could not push nfl-live.json after 5 attempts; will retry next tick');
  return false;
}

let idleTicks = 0;

async function tick() {
  let data;
  try { data = await fetchScoreboard(); }
  catch (e) { console.error(`tick skipped (${e.message})`); return true; } // keep looping

  const events = data.events || [];
  if (!events.length) { console.log('no events — offseason/bye'); return false; }

  const games = {};
  let live = 0, post = 0;
  for (const ev of events) {
    const l = extractLive(ev);
    if (!l) continue;
    games[String(ev.id)] = l;
    if (l.status === 'in') live++;
    else if (l.status === 'post') post++;
  }
  const changed = commitIfChanged(games);
  if (changed) {
    const summary = Object.values(games).map(g => g.awayScore != null ? `${g.awayScore}-${g.homeScore}` : '?').join(' ');
    console.log(`committed: ${live} live / ${post} final — ${summary}`);
  }
  // Smart exit: once every game is final (no live, some final), the slate is
  // done — stop burning Actions minutes. A couple idle ticks guards against a
  // transient ESPN gap right at kickoff.
  if (live === 0 && post > 0) { idleTicks++; if (idleTicks >= 2) { console.log('slate wrapped up — exiting'); return false; } }
  else idleTicks = 0;
  return true;
}

(async () => {
  let n = 0;
  for (;;) {
    n++;
    const keepGoing = await tick().catch(e => { console.error('tick crashed:', e.message); return true; });
    if (!keepGoing) break;
    if (MAX_TICKS > 0 && n >= MAX_TICKS) { console.log(`reached MAX_TICKS=${MAX_TICKS}`); break; }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.log(`poller finished after ${n} tick(s)`);
})().catch(e => { console.error('fatal:', e); process.exit(1); });
