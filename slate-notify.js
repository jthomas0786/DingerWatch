#!/usr/bin/env node
/**
 * slate-notify.js — fires two push notifications right after the daily slate
 * builds: (1) a slate summary, (2) the top 3 HR leaders + probability %.
 *
 * The HR probabilities come from the same Monte Carlo model the UI uses
 * (simulatePlayer), loaded into Node via model-engine-vm.js — there is no
 * second probability formula. The top 3 are seeded for determinism so a rerun
 * can't send a different list.
 *
 *   node slate-notify.js            # send to every subscriber
 *   node slate-notify.js --dry-run   # print the payloads, send nothing
 *
 * Env (GitHub Actions secrets, same as realtime-poll.js):
 *   VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import fs from 'node:fs';
import webpush from 'web-push';
import { EngineVM } from './model-engine-vm.js';
import { stripComments } from './model-logger.js';
import { fetchAllSubscriptions, pruneDeadSubscriptions, checkVapidKeysMatch } from './send-push.js';

const DRY = process.argv.includes('--dry-run');
const SLATE_PATH = process.env.SLATE_PATH || './slate.json';

const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@example.com';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Dry-run only needs the slate + model (no VAPID/Supabase). Real sends need all.
if (!DRY) {
  if (!VAPID_PRIVATE || !VAPID_PUBLIC) {
    console.error('✗ VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY not set — run gen-vapid-keys.js');
    process.exit(1);
  }
  if (!checkVapidKeysMatch(VAPID_PRIVATE, VAPID_PUBLIC)) {
    console.error('✗ stopping — VAPID private/public do not match; sending would only fail.');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('✗ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — add them as repo secrets');
    process.exit(1);
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

// A subscription is permanently dead under the same conditions realtime-poll
// uses: endpoint gone (404/410), or the VAPID key it was created under no
// longer matches (Apple 400 VapidPkHashMismatch / FCM 403 "do not correspond").
const isSubDead = (code, body) =>
  code === 404 || code === 410 ||
  (code === 403 && /do not correspond|VapidPkHashMismatch/i.test(body)) ||
  (code === 400 && /VapidPkHashMismatch/i.test(body));

/** Build the two notification payloads from the slate + model. */
function buildPayloads(slate) {
  const vm = new EngineVM('./index.html');
  vm.setSeed(`${slate.date}:${slate.generatedAt || ''}:slate-notify`);
  vm.load();

  // Apply the same tuned model-config.json the UI uses (it's JSONC w/ comments).
  let cfgApplied = false;
  try {
    const cfg = JSON.parse(stripComments(fs.readFileSync('./model-config.json', 'utf8')));
    vm.api.applyConfig(cfg);
    cfgApplied = true;
  } catch (e) {
    console.warn(`  ! could not apply model-config.json: ${e.message}`);
  }

  const batters = vm.api.loadSlate(slate);
  if (!Array.isArray(batters) || batters.length === 0) {
    throw new Error(`loadSlate returned no batters (slate.date=${slate.date})`);
  }

  const players = vm.api.predict(['hr']);
  if (!players.length) throw new Error('predict returned no players');

  const top = [...players]
    .sort((a, b) => (b.props?.hr?.pct ?? 0) - (a.props?.hr?.pct ?? 0))
    .slice(0, 3);

  const gameCount = slate.gameCount ?? (slate.games || []).length;

  // Earliest first pitch, for the summary. Eastern time matches the slate's
  // builtForEasternDate framing.
  let firstPitch = null;
  for (const g of slate.games || []) {
    const t = g.startTimeUTC ? Date.parse(g.startTimeUTC) : NaN;
    if (!isNaN(t) && (firstPitch === null || t < firstPitch)) firstPitch = t;
  }
  const fpStr = firstPitch
    ? new Date(firstPitch).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET'
    : 'TBD';

  const weekday = new Date(slate.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  const summary = {
    type: 'generic',
    key: `slate-summary-${slate.date}`,
    title: "⚾ Today's Slate",
    body: `${weekday} ${slate.date} · ${gameCount} game${gameCount === 1 ? '' : 's'} · first pitch ${fpStr}`,
    url: 'index.html',
  };

  const top3Body = top
    .map((p, i) => `${i + 1}. ${p.name} ${p.props.hr.pct}%`)
    .join('  ·  ');
  const top3 = {
    type: 'generic',
    key: `slate-top3-${slate.date}`,
    title: 'Top 3 HR Today',
    body: top3Body || 'No picks available',
    url: 'index.html',
  };

  return { summary, top3, gameCount, top, cfgApplied };
}

async function send(payload) {
  const subs = await fetchAllSubscriptions();
  const body = JSON.stringify(payload);
  let ok = 0;
  const deadIds = [];
  for (const sub of subs) {
    if (!sub?.endpoint || !sub.p256dh || !sub.auth_key) continue;
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        body,
        { TTL: 86400, urgency: 'normal' },
      );
      ok++;
    } catch (e) {
      const code = e.statusCode;
      const ebody = String(e.body ?? '');
      if (isSubDead(code, ebody)) deadIds.push(sub.id);
      else console.warn(`  ! push failed ${code ?? '?'}: ${ebody.slice(0, 120) || e.message}`);
    }
  }
  if (deadIds.length) await pruneDeadSubscriptions(deadIds);
  return { ok, total: subs.length, pruned: deadIds.length };
}

async function main() {
  const slate = JSON.parse(fs.readFileSync(SLATE_PATH, 'utf8'));
  if (!slate || !slate.date || !Array.isArray(slate.games)) {
    console.error('✗ slate.json missing date/games — not notifying');
    process.exit(1);
  }
  const gameCount = slate.gameCount ?? slate.games.length;
  if (gameCount === 0) {
    console.log('slate has 0 games — nothing to notify');
    return;
  }

  const { summary, top3, top, cfgApplied } = buildPayloads(slate);
  console.log(`slate ${slate.date} · ${gameCount} games · cfg ${cfgApplied ? 'applied' : 'defaults'}`);
  console.log('  [1]', summary.title, '—', summary.body);
  console.log('  [2]', top3.title, '—', top3.body);

  if (DRY) {
    console.log('\n(dry run — no pushes sent)');
    return;
  }

  // One push carrying both generic items; sw.js renders two notifications.
  const res = await send([summary, top3]);
  console.log(`\n✓ slate notification sent to ${res.ok}/${res.total} device(s)${res.pruned ? ` · ${res.pruned} pruned (expired)` : ''}`);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
