#!/usr/bin/env node
/**
 * realtime-poll.js — near-real-time home run push poller.
 *
 * Runs as a LONG-RUNNING GitHub Actions job (the repo is public, so Actions
 * minutes are unlimited). It polls the MLB Stats API every ~25 seconds, and
 * the instant it sees a home run it hasn't sent yet, it pushes an ENCRYPTED
 * payload straight to every subscribed device. Latency from a ball landing in
 * the seats to a phone buzzing is roughly one poll interval (~25s) plus the
 * push service's own delivery time.
 *
 * Why encrypted payloads (not the bare wake-up that send-push.js uses):
 *   sw.js already supports push payloads — if the push carries JSON, the worker
 *   reads it directly and never has to fetch latest-hr.json. That sidesteps
 *   GitHub Pages' deployment lag entirely (Pages can sit ~1 min behind a commit),
 *   so the notification that arrives in ~25s shows the right home run, not a
 *   stale one. Bare pushes only make sense when the worker can fetch fresh data
 *   on demand; here it can't, fast enough, so we send the data with the push.
 *
 * Coexistence with the 5-minute push.yml cron:
 *   push.yml stays as a fallback + ledger committer. Because this poller keeps
 *   its dedup ledger in memory only, push.yml (every 5 min) will re-see a just-
 *   pushed home run as "new" and re-send it as a bare push, then commit the
 *   ledger. That re-send is harmless: sw.js dedups by home-run key (seen keys
 *   live in CacheStorage, which persists across worker restarts), so a device
 *   never shows the same homer twice. If this long-running job is ever down,
 *   push.yml keeps notifications flowing at 5-minute latency until it restarts.
 *
 *   node realtime-poll.js --dry-run
 */
import webpush from 'web-push';
import {
  todayEastern, collectHomeRuns, readJSON, getJSON,
  fetchAllSubscriptions, pruneDeadSubscriptions, checkVapidKeysMatch,
} from './send-push.js';

const MLB = 'https://statsapi.mlb.com/api/v1';

const STATE_FILE = process.env.PUSH_STATE_FILE || 'pushed-hrs.json';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const POLL_MS = Number(process.env.POLL_MS || 25000);
// For smoke tests only: exit after N ticks (0 = run until timeout/SIGTERM).
const MAX_TICKS = Number(process.env.MAX_TICKS || 0);

const DRY = process.argv.includes('--dry-run');
const TEST = process.argv.includes('--test');   // send one test push to every device, then exit

// ---- preflight --------------------------------------------------------------
if (!VAPID_PRIVATE || !VAPID_PUBLIC) {
  console.error('✗ VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY not set — run gen-vapid-keys.js');
  process.exit(1);
}
if (!checkVapidKeysMatch()) {
  console.error('✓ stopping — VAPID private/public do not match; sending would only fail.');
  process.exit(1);
}
if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — add them as repo secrets');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A subscription is permanently dead if the endpoint is gone (404/410) OR the
// VAPID key it was created under no longer matches the one we're sending with.
// Apple reports that as a 400 {reason:VapidPkHashMismatch}; FCM reports it as a
// 403 "credentials ... do not correspond". Either way the only fix is for the
// device to re-subscribe (which the app does automatically on next open), so we
// prune it instead of retrying it forever.
const isSubDead = (code, body) =>
  code === 404 || code === 410 ||
  (code === 403 && /do not correspond|VapidPkHashMismatch/i.test(body)) ||
  (code === 400 && /VapidPkHashMismatch/i.test(body));

// How many of the most recent new homers to pack into one push. sw.js caps its
// own display at the newest 5 anyway, and a smaller payload encrypts faster and
// stays well under the 4KB push-service limit.
const BATCH = 5;

/**
 * Send one encrypted JSON payload carrying the newest homers to every device.
 * web-push handles the aes128gcm + ECDH key agreement per subscription (each
 * device has its own p256dh/auth key pair), which is exactly the crypto
 * send-push.js deliberately avoided hand-rolling.
 */
async function pushBatch(hrs) {
  if (DRY) return { ok: 0, total: 0, pruned: 0 };   // dry run never sends or fetches
  const subs = await fetchAllSubscriptions();
  const payload = JSON.stringify(hrs.slice(-BATCH));

  let ok = 0;
  const deadIds = [];
  for (const sub of subs) {
    if (!sub?.endpoint || !sub.p256dh || !sub.auth_key) continue;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        payload,
        { TTL: 900, urgency: 'high' },
      );
      ok++;
    } catch (e) {
      const code = e.statusCode;
      const body = String(e.body ?? '');
      if (isSubDead(code, body)) {
        deadIds.push(sub.id);
      } else {
        console.warn(`  ! push failed ${code ?? '?'}: ${body.slice(0, 120) || e.message}`);
      }
    }
  }
  if (deadIds.length) await pruneDeadSubscriptions(deadIds);
  return { ok, total: subs.length, pruned: deadIds.length };
}

/** Count currently-Live games on today's slate (for idle-exit only). */
async function countLiveGames(date) {
  try {
    const sched = await getJSON(`${MLB}/schedule?sportId=1&date=${date}`);
    const games = (sched.dates || []).flatMap(d => d.games || []);
    return games.filter(g => g.status?.abstractGameState === 'Live').length;
  } catch { return -1; }   // unknown — treat as live so we never exit early on a fetch blip
}

// ---- main loop --------------------------------------------------------------
let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGTERM', () => { console.log('\n SIGTERM received — finishing loop and exiting'); stop(); });
process.on('SIGINT', stop);

async function loop() {
  const date = todayEastern();
  console.log(`▸ realtime poller · ${date}${DRY ? ' (dry run)' : ''} · every ${POLL_MS}ms`);

  // Load the persisted ledger (committed by push.yml's 5-min cron) so a
  // restarted job doesn't re-blast the last few minutes of homers. Stale by up
  // to ~5 min on cold start; sw.js seen-key dedup covers any gap.
  const state = await readJSON(STATE_FILE, { pushed: [] });
  const pushed = new Set(state.pushed || []);

  let tick = 0;
  while (!stopping) {
    tick++;
    try {
      const live = await countLiveGames(date);
      const all = await collectHomeRuns(date);
      const fresh = all.filter(h => !pushed.has(h.key));
      if (fresh.length) {
        console.log(`  [${new Date().toISOString().slice(11,19)}] ${all.length} HR · ${fresh.length} new · ${live} live — pushing`);
        const res = await pushBatch(fresh);
        if (DRY) {
          fresh.slice(-BATCH).forEach(h => console.log(`  would notify: ${h.batter} ${h.exitVelo ?? '?'} mph ${h.distance ?? '?'} ft`));
        } else {
          console.log(`  pushed to ${res.ok}/${res.total} device(s)${res.pruned ? ` · ${res.pruned} pruned` : ''}`);
          fresh.forEach(h => pushed.add(h.key));
        }
      } else {
        if (tick % 12 === 0) console.log(`  [${new Date().toISOString().slice(11,19)}] ${all.length} HR · 0 new · ${live} live`);
      }
    } catch (e) {
      console.warn(`  ! poll error (will retry next tick): ${e.message}`);
    }
    if (MAX_TICKS && tick >= MAX_TICKS) {
      console.log(`✓ reached MAX_TICKS=${MAX_TICKS} — exiting (smoke test)`);
      break;
    }
    await sleep(POLL_MS);
  }
  console.log('✓ realtime poller stopped');
}

/** Send ONE clearly-labeled test notification to every subscribed device.
 *  Verifies the full encrypted-push path end-to-end without needing a real HR. */
async function runSelfTest() {
  const subs = await fetchAllSubscriptions();
  if (!subs.length) { console.log('✗ no subscribed devices found — subscribe from the app first'); return; }
  // batterId 999999 is on nobody's watchlist, so sw.js falls back to showing the
  // newest HR in the batch (this one). A unique key keeps it out of seen-key dedup.
  const testHr = {
    key: 'test-' + Date.now(),
    batter: 'TEST (Dinger Watch check)',
    batterId: 999999,
    exitVelo: 0, distance: 0, launchAngle: null,
    half: 'Self-test', inning: 'push',
    battingTeam: 'Dinger Watch', opponent: 'delivery check',
    date: todayEastern(),
  };
  const payload = JSON.stringify([testHr]);
  let ok = 0;
  const deadIds = [];
  for (const sub of subs) {
    if (!sub?.endpoint || !sub.p256dh || !sub.auth_key) continue;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        payload, { TTL: 900, urgency: 'high' });
      ok++;
    } catch (e) {
      const code = e.statusCode; const body = String(e.body ?? '');
      if (isSubDead(code, body)) {
        deadIds.push(sub.id);
      } else {
        console.warn(`  ! test push failed ${code ?? '?'}: ${body.slice(0, 120) || e.message}`);
      }
    }
  }
  if (deadIds.length) await pruneDeadSubscriptions(deadIds);
  console.log(`✓ test push sent to ${ok}/${subs.length} device(s)${deadIds.length ? ` · ${deadIds.length} pruned (expired)` : ''}`);
}

if (TEST) {
  runSelfTest().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
} else {
  loop().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
}
