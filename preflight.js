#!/usr/bin/env node
/**
 * preflight.js — checks every piece background push needs, and reports exactly
 * which are missing.
 *
 * Background push silently does nothing until ALL of these line up, and no
 * single piece reports its own absence. This checks them together.
 *
 *   node preflight.js                    # check the local repo
 *   node preflight.js --url https://you.github.io/Repo/public/
 *                                        # also check what's actually deployed
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
};
const URL_BASE = arg('--url');
const ROOT = arg('--dir') || 'public';

const results = [];
const ok   = (name, detail) => results.push({ level:'ok',   name, detail });
const warn = (name, detail, fix) => results.push({ level:'warn', name, detail, fix });
const fail = (name, detail, fix) => results.push({ level:'fail', name, detail, fix });

const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return null; } };
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// ---------------------------------------------------------------- local files
async function checkLocal() {
  console.log(`\n▸ Checking local files in ./${ROOT}\n`);

  // --- index.html ---
  const idxPath = path.join(ROOT, 'index.html');
  const idx = await read(idxPath);
  if (!idx) {
    fail('index.html', `not found at ${idxPath}`,
         `Copy the dashboard HTML to ${idxPath}`);
    return { idx: null };
  }
  ok('index.html', `${(idx.length / 1024).toFixed(0)} KB`);

  // Which build is deployed? The old one states it can't do background push.
  // Detect by capability, not by footer prose — copy drifts, code doesn't.
  // The pre-push build states its own limitation in the footer, which makes it
  // trivially identifiable — and it's the single most common cause of "my
  // notifications don't work when the app is closed".
  if(idx.includes('nothing arrives with the tab closed')){
    fail('Build vintage',
         'index.html is the OLD build — in-page notifications only',
         'That footer text exists only in the pre-push version.\n' +
         'Background push was added later. Upload the current index.html.');
  }

  const hasPushCode = idx.includes('registerServiceWorker') && idx.includes('pushManager.subscribe');
  if (hasPushCode) {
    ok('Build version', 'current build with Web Push support');
  } else {
    fail('Build version', 'OLD build — no Web Push code, in-page alerts only',
         'Upload the current index.html. Without it nothing below will help.');
  }

  // --- VAPID public key ---
  const m = idx.match(/const VAPID_PUBLIC_KEY\s*=\s*['"]([^'"]*)['"]/);
  if (!m) {
    fail('VAPID key', 'VAPID_PUBLIC_KEY not present in index.html',
         'Upload the current index.html');
  } else if (!m[1]) {
    fail('VAPID key', 'present but EMPTY — push cannot be enabled',
         'Run: node gen-vapid-keys.js\nPaste the public key into index.html as VAPID_PUBLIC_KEY');
  } else if (m[1].length < 80) {
    fail('VAPID key', `looks malformed (${m[1].length} chars, expected ~87)`,
         'Regenerate with gen-vapid-keys.js and paste the PUBLIC key');
  } else {
    ok('VAPID key', `${m[1].slice(0, 14)}… (${m[1].length} chars)`);
  }

  // --- service worker ---
  const swPath = path.join(ROOT, 'sw.js');
  if (!(await exists(swPath))) {
    fail('sw.js', `not found at ${swPath}`,
         `Copy sw.js into ${ROOT}/ — it must sit beside index.html, not at the repo root.\n` +
         `A worker's scope is its own directory, so one at the root can't control /${ROOT}/.`);
  } else {
    const sw = await read(swPath);
    if (!sw.includes("addEventListener('push'")) {
      fail('sw.js', 'no push listener found', 'Re-copy sw.js');
    } else {
      ok('sw.js', 'push + notificationclick handlers present');
    }
  }

  // --- subscriptions ---
  const subPath = path.join(ROOT, 'push-subscriptions.json');
  const subRaw = await read(subPath);
  if (subRaw === null) {
    fail('push-subscriptions.json', `not found at ${subPath}`,
         `Create it containing:  []\nThen enable Alerts in the app and paste in the subscription it shows.`);
  } else {
    let subs;
    try { subs = JSON.parse(subRaw); } catch {
      fail('push-subscriptions.json', 'invalid JSON', 'Check for a trailing comma');
      subs = null;
    }
    if (Array.isArray(subs)) {
      if (subs.length === 0) {
        fail('Subscriptions', 'file exists but is EMPTY — no device will be pushed to',
             'Open the app → 🔔 Alerts → copy the subscription JSON it shows →\n' +
             `add it to ${subPath} as an array item → commit and push.\n` +
             'This step is manual because GitHub Pages cannot accept a POST.');
      } else {
        const bad = subs.filter(s => !s?.endpoint || !s?.keys?.p256dh);
        if (bad.length) {
          warn('Subscriptions', `${subs.length} entries, ${bad.length} malformed`,
               'Each entry needs endpoint + keys.p256dh + keys.auth');
        } else {
          const hosts = [...new Set(subs.map(s => { try { return new URL(s.endpoint).host; } catch { return '?'; } }))];
          ok('Subscriptions', `${subs.length} device(s) · ${hosts.join(', ')}`);
        }
      }
    }
  }

  // --- workflow ---
  const wfDir = '.github/workflows';
  let found = null;
  try {
    for (const f of await fs.readdir(wfDir)) {
      const c = await read(path.join(wfDir, f));
      if (c && c.includes('send-push.js')) { found = f; break; }
    }
  } catch { /* no workflows dir */ }
  if (!found) {
    fail('Push workflow', `no workflow running send-push.js in ${wfDir}/`,
         `Copy push.yml to ${wfDir}/push.yml`);
  } else {
    ok('Push workflow', `${wfDir}/${found}`);
  }

  // --- sender script ---
  const senderHere = await exists('send-push.js') || await exists('slate-builder/send-push.js');
  if (!senderHere) {
    fail('send-push.js', 'not found in repo root or slate-builder/',
         'Copy send-push.js to the repo root (the workflow runs it from there)');
  } else {
    ok('send-push.js', 'present');
  }

  // Secrets can't be read from here — flag them as a manual check.
  warn('Repo secrets', 'cannot be verified from outside GitHub',
       'Settings → Secrets and variables → Actions must contain:\n' +
       '  VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT');

  return { idx };
}

// ---------------------------------------------------------------- deployed
async function checkDeployed(base) {
  console.log(`\n▸ Checking what's actually live at ${base}\n`);
  const url = (p) => new URL(p, base.endsWith('/') ? base : base + '/').href;

  const get = async (p) => {
    try {
      const r = await fetch(url(p), { redirect: 'follow' });
      return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
    } catch (e) { return { ok: false, status: 0, text: '', err: e.message }; }
  };

  const page = await get('index.html');
  if (!page.ok) {
    fail('Deployed page', `index.html returned ${page.status || page.err}`,
         'Check the GitHub Pages URL and that the site has finished deploying.\n' +
         'NOTE: a 403 usually means the network you are running this from blocks\n' +
         'outbound requests (corporate proxy, sandbox). Open the URL in a browser —\n' +
         'if it loads there, ignore every LIVE check below and trust the local ones.');
  } else {
    ok('Deployed page', `index.html reachable (${(page.text.length/1024).toFixed(0)} KB)`);

    const liveHasPush = page.text.includes('registerServiceWorker') && page.text.includes('pushManager.subscribe');
    if (!liveHasPush) {
      fail('Deployed build', 'the LIVE site is the OLD build (in-page alerts only)',
           'Upload the current index.html — this alone explains no alerts when closed.');
    } else {
      ok('Deployed build', 'current build with Web Push support');
    }

    const dm = page.text.match(/const VAPID_PUBLIC_KEY\s*=\s*['"]([^'"]*)['"]/);
    if (dm && !dm[1]) {
      fail('Deployed VAPID key', 'empty on the live site',
           'Paste your public key into index.html and re-upload');
    } else if (dm) {
      ok('Deployed VAPID key', `${dm[1].slice(0, 14)}…`);
    }
  }

  for (const [file, label] of [['sw.js','Deployed sw.js'],
                               ['manifest.webmanifest','Deployed manifest'],
                               ['slate.json','Deployed slate.json'],
                               ['push-subscriptions.json','Deployed subscriptions']]) {
    const r = await get(file);
    if (!r.ok) {
      fail(label, `${file} → HTTP ${r.status || r.err}`,
           `Upload ${file} into the same folder as index.html`);
    } else if (file === 'slate.json') {
      try {
        const s = JSON.parse(r.text);
        const age = s.generatedAt ? Math.round((Date.now() - new Date(s.generatedAt)) / 3600000) : null;
        ok(label, `${s.gameCount ?? s.games?.length ?? '?'} games, for ${s.date}` + (age != null ? `, built ${age}h ago` : ''));
        if (s.date && s.date !== new Date().toISOString().slice(0,10)) {
          warn('Slate freshness', `slate is for ${s.date}, today is ${new Date().toISOString().slice(0,10)}`,
               'Rerun the daily build workflow');
        }
      } catch { warn(label, 'served but not valid JSON', 'Check the build output'); }
    } else if (file === 'push-subscriptions.json') {
      try {
        const subs = JSON.parse(r.text);
        if (!subs.length) fail(label, 'live file is an empty array — nobody is subscribed',
                               'Enable Alerts in the app and commit the subscription JSON');
        else ok(label, `${subs.length} subscribed device(s)`);
      } catch { warn(label, 'served but not valid JSON'); }
    } else {
      ok(label, `${file} reachable`);
    }
  }

  // Push requires a secure context. GitHub Pages is HTTPS, but a custom domain
  // served over HTTP would silently disable the whole API.
  if (!base.startsWith('https://')) {
    fail('HTTPS', 'site is not served over HTTPS',
         'Notifications and service workers require a secure context');
  } else {
    ok('HTTPS', 'secure context');
  }
}

// ---------------------------------------------------------------- report
function report() {
  const icon = { ok:'✓', warn:'!', fail:'✗' };
  const pad = Math.max(...results.map(r => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.name.padEnd(pad)}  ${r.detail}`);
  }

  const fails = results.filter(r => r.level === 'fail');
  const warns = results.filter(r => r.level === 'warn');

  console.log('\n' + '─'.repeat(64));
  if (!fails.length) {
    console.log('\n✓ Everything required for background push is in place.');
    console.log('  If notifications still don\'t arrive, check the Actions tab for');
    console.log('  failed runs of the push workflow.');
  } else {
    console.log(`\n${fails.length} blocking issue(s) — background push will NOT work until these are fixed:\n`);
    fails.forEach((r, i) => {
      console.log(`${i + 1}. ${r.name}: ${r.detail}`);
      if (r.fix) r.fix.split('\n').forEach(l => console.log(`   → ${l}`));
      console.log('');
    });
  }
  if (warns.length) {
    console.log('Also worth checking:\n');
    warns.forEach(r => {
      console.log(`  · ${r.name}: ${r.detail}`);
      if (r.fix) r.fix.split('\n').forEach(l => console.log(`      ${l}`));
    });
  }
  console.log('');
  process.exit(fails.length ? 1 : 0);
}

const { idx } = await checkLocal();
if (URL_BASE) await checkDeployed(URL_BASE);
report();
