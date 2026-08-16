#!/usr/bin/env node
/**
 * send-push.js — detects new home runs and wakes subscribed devices.
 *
 * Runs in GitHub Actions, so it works with every browser closed.
 *
 * HOW THE PUSH ITSELF WORKS
 * Web Push normally requires encrypting the payload (aes128gcm + ECDH), which
 * is a lot of fragile hand-rolled crypto. This sends a *bare* push instead —
 * no payload, just a wake-up signal. Bare pushes only need VAPID JWT auth,
 * which is a single ES256 signature. The service worker then fetches
 * latest-hr.json for the details, so what it shows is current at display time
 * rather than whenever the message was queued.
 *
 * That keeps this script dependency-free and much harder to get subtly wrong.
 *
 *   node send-push.js --dry-run
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const MLB = 'https://statsapi.mlb.com/api/v1';
const LATEST_FILE = process.env.LATEST_FILE || 'latest-hr.json';
const STATE_FILE = process.env.PUSH_STATE_FILE || 'pushed-hrs.json';
const DRY = process.argv.includes('--dry-run');

const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';

// Subscriptions live in Supabase now, not a file in the repo — a static
// push-subscriptions.json requiring a manual copy-paste-and-commit per user
// only ever worked for one developer testing on their own device. This uses
// the SERVICE ROLE key specifically, which bypasses the per-user RLS every
// other table in this app enforces — appropriate here because this script
// IS the trusted server-side batch job, not a browser acting on a user's
// behalf. Plain fetch against Supabase's REST API, no SDK dependency, same
// as the rest of this script.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const b64url = b => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const todayEastern = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function getJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'dinger-watch-push/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 400 * 2 ** i));
    }
  }
}

// ---------------------------------------------------------------- VAPID
/**
 * Build the Authorization header for one push endpoint. The JWT audience must
 * be the push service's ORIGIN only — including the path is the single most
 * common reason a push is rejected with 401.
 */
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,   // spec caps this at 24h
    sub: VAPID_SUBJECT,
  }));
  const unsigned = `${header}.${payload}`;

  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: VAPID_PRIVATE,
           x: b64url(fromB64url(VAPID_PUBLIC).subarray(1, 33)),
           y: b64url(fromB64url(VAPID_PUBLIC).subarray(33, 65)) },
    format: 'jwk',
  });

  // Node emits DER by default; JWS requires the raw 64-byte r||s form.
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(sig)}, k=${VAPID_PUBLIC}`;
}

async function sendBarePush(sub) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint),
      TTL: '900',                       // drop it if undelivered after 15 min
      'Content-Length': '0',
      Urgency: 'high',
    },
  });
  return res;
}

/**
 * Proves — rather than assumes — whether VAPID_PRIVATE_KEY and
 * VAPID_PUBLIC_KEY actually correspond to the same key pair, by
 * mathematically DERIVING the public key from the private scalar and
 * comparing it to what's configured. This doesn't trust "I regenerated them
 * together correctly" — it checks the real runtime values directly, however
 * they actually got there (copy-paste error, stale secret, wrong slot, etc).
 * Never prints the private key itself, only whether the two match.
 */
function checkVapidKeysMatch() {
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64url(VAPID_PRIVATE));
    const derivedPublic = b64url(ecdh.getPublicKey());
    const match = derivedPublic === VAPID_PUBLIC;
    console.log(`  VAPID key check: private/public ${match ? 'MATCH ✓' : 'DO NOT MATCH ✗'}`);
    if (!match) {
      console.log(`    configured public key:     ${VAPID_PUBLIC}`);
      console.log(`    public key this private key actually produces: ${derivedPublic}`);
      console.log('    → these must be regenerated as one pair — see gen-vapid-keys.js');
    }
    return match;
  } catch (e) {
    console.log(`  VAPID key check: could not even parse VAPID_PRIVATE_KEY (${e.message})`);
    console.log('    → the secret value itself is likely malformed (stray whitespace, wrong value, truncated)');
    return false;
  }
}

// ---------------------------------------------------------------- push subscriptions
async function fetchAllSubscriptions() {
  const url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth_key`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase subscription fetch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** One batched DELETE rather than one request per dead subscription. */
async function pruneDeadSubscriptions(ids) {
  if (!ids.length) return;
  const url = `${SUPABASE_URL}/rest/v1/push_subscriptions?id=in.(${ids.join(',')})`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    console.warn(`  ! failed to prune ${ids.length} dead subscription(s): ${res.status}`);
  }
}

// ---------------------------------------------------------------- home runs
async function collectHomeRuns(date) {
  const sched = await getJSON(`${MLB}/schedule?sportId=1&date=${date}&hydrate=venue,team`);
  const games = (sched.dates || []).flatMap(d => d.games || [])
    .filter(g => ['Live', 'Final'].includes(g.status?.abstractGameState));

  const out = [];
  for (const g of games) {
    let pbp;
    try { pbp = await getJSON(`${MLB}/game/${g.gamePk}/playByPlay`); }
    catch { continue; }
    for (const play of pbp.allPlays || []) {
      if (play.result?.eventType !== 'home_run') continue;
      const hit = [...(play.playEvents || [])].reverse()
        .find(e => e.hitData?.launchSpeed != null);
      const hd = hit?.hitData || {};
      out.push({
        key: `${g.gamePk}:${play.atBatIndex}`,
        batter: play.matchup?.batter?.fullName ?? 'Unknown',
        pitcher: play.matchup?.pitcher?.fullName ?? null,
        inning: play.about?.inning,
        half: play.about?.isTopInning ? 'Top' : 'Bot',
        battingTeam: play.about?.isTopInning
          ? g.teams.away.team.abbreviation : g.teams.home.team.abbreviation,
        opponent: play.about?.isTopInning
          ? g.teams.home.team.abbreviation : g.teams.away.team.abbreviation,
        rbi: play.result?.rbi ?? 0,
        exitVelo: hd.launchSpeed ?? null,
        launchAngle: hd.launchAngle ?? null,
        distance: hd.totalDistance ?? null,
        park: g.venue?.name ?? '',
        ts: play.about?.endTime ? new Date(play.about.endTime).getTime() : Date.now(),
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const readJSON = async (p, fallback) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
};
const writeJSON = async (p, v) => {
  await fs.mkdir(p.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await fs.writeFile(p, JSON.stringify(v, null, 2));
};

// ---------------------------------------------------------------- main
async function main() {
  const date = todayEastern();
  console.log(`▸ push sender · ${date}${DRY ? ' (dry run)' : ''}`);

  if (!DRY && (!VAPID_PRIVATE || !VAPID_PUBLIC)) {
    console.error('✗ VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY not set — run gen-vapid-keys.js');
    process.exit(1);
  }
  if (VAPID_PRIVATE && VAPID_PUBLIC && !checkVapidKeysMatch()) {
    if (!DRY) { console.error('✗ Stopping — sending would just fail with the same 403 as before.'); process.exit(1); }
  }
  if (!DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
    console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — add them as repo secrets');
    console.error('  (this is the SAME service role key already used elsewhere, but it needs adding');
    console.error('   here separately — GitHub Actions secrets and Supabase Edge Function secrets');
    console.error('   are two different secret stores even though the value is identical.)');
    process.exit(1);
  }

  const state = await readJSON(STATE_FILE, { pushed: [] });
  const pushed = new Set(state.pushed || []);
  const all = await collectHomeRuns(date);
  const fresh = all.filter(h => !pushed.has(h.key));

  console.log(`  ${all.length} HR today · ${fresh.length} not yet pushed`);
  if (!fresh.length) { console.log('✓ nothing new'); return; }

  // Cold start: don't blast a day's backlog at everyone.
  if (pushed.size === 0 && fresh.length > 5) {
    console.log(`  cold start (${fresh.length} backlog) — recording without pushing`);
    await writeJSON(STATE_FILE, { updatedAt: new Date().toISOString(), pushed: all.map(h => h.key) });
    await writeJSON(LATEST_FILE, { updatedAt: new Date().toISOString(), homeRuns: [] });
    return;
  }

  // The worker reads this after being woken.
  await writeJSON(LATEST_FILE, {
    updatedAt: new Date().toISOString(),
    homeRuns: fresh.slice(-5),
  });
  console.log(`  wrote ${LATEST_FILE} with ${Math.min(fresh.length, 5)} HR`);

  const list = DRY && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    ? []   // dry-run without Supabase configured yet: still show what WOULD be sent
    : await fetchAllSubscriptions();
  console.log(`  ${list.length} subscribed device(s)`);

  if (DRY) {
    fresh.slice(-5).forEach(h => console.log(`  would notify: ${h.batter} ${h.exitVelo ?? '?'} mph ${h.distance ?? '?'} ft`));
    return;
  }

  let ok = 0;
  const deadIds = [];
  for (const sub of list) {
    if (!sub?.endpoint) continue;
    try {
      const res = await sendBarePush(sub);
      if (res.status === 404 || res.status === 410) {
        // Subscription is gone for good — prune it.
        deadIds.push(sub.id);
        console.log(`  · expired subscription pruned (${res.status})`);
      } else if (!res.ok) {
        const body = await res.text();
        // A key mismatch is just as permanently dead as a 404/410, even
        // though it isn't one — the device subscribed under an OLD VAPID
        // key (before a rotation) and will get a genuinely NEW endpoint the
        // next time it reopens the app and re-subscribes under the current
        // one. Retrying THIS row will never succeed no matter how many times
        // it's attempted; only pruning it stops it from failing forever.
        if (body.includes('VapidPkHashMismatch')) {
          deadIds.push(sub.id);
          console.log(`  · subscription pruned — belongs to an old VAPID key (${res.status})`);
        } else {
          console.warn(`  ! push failed ${res.status}: ${body.slice(0, 160)}`);
        }
      } else { ok++; }
    } catch (e) {
      console.warn(`  ! push error: ${e.message}`);
    }
  }
  console.log(`  pushed to ${ok}/${list.length}`);

  if (deadIds.length) {
    await pruneDeadSubscriptions(deadIds);
    console.log(`  removed ${deadIds.length} dead subscription(s)`);
  }

  // Only mark these home runs as delivered if delivery actually happened —
  // previously this ran unconditionally, so a total failure (wrong VAPID
  // keys, a push service outage, any transient error) still marked every
  // fresh home run as "done," permanently, with no retry. The exact bug that
  // made tonight's testing impossible: the earlier 403s had already marked
  // those home runs as pushed despite nobody receiving them.
  //
  // list.length === 0 (nobody subscribed yet) still marks as done — there's
  // no one to retry toward, so holding these forever would only build up a
  // meaningless backlog. A real send attempt that fully failed (ok === 0
  // with subscribers present) does NOT get marked — that's what makes the
  // next run retry it automatically instead of silently giving up.
  const shouldMarkDone = list.length === 0 || ok > 0;
  if (shouldMarkDone) {
    fresh.forEach(h => pushed.add(h.key));
    await writeJSON(STATE_FILE, {
      updatedAt: new Date().toISOString(),
      pushed: [...pushed].slice(-3000),
    });
  } else {
    console.warn(`  ! every send failed — NOT marking ${fresh.length} home run(s) as pushed, will retry next run`);
  }
  console.log('✓ done');
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
