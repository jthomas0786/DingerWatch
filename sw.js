/**
 * sw.js — Dinger Watch service worker
 *
 * Runs independently of any open page, which is what makes notifications work
 * when the app is closed. It cannot poll on its own — browsers don't permit
 * that — so it sleeps until the push service wakes it.
 *
 * Deliberate design choice: pushes carry NO payload. Encrypting a Web Push
 * payload requires aes128gcm + ECDH key agreement, which is a lot of fragile
 * hand-rolled crypto. Instead the push is a bare "wake up" signal and the
 * worker fetches the actual home run from latest-hr.json. Simpler, and the
 * data is always current at display time rather than whenever it was queued.
 */

const VERSION = 'dw-sw-v1';
const LATEST_URL = 'latest-hr.json';
const ICON = 'icon-192.png';

/**
 * The page mirrors the signed-in user's watch list into this cache entry (see
 * syncWatchlistToSW in index.html) because a worker running with every tab
 * closed has no session and cannot query Supabase. Absent entry means "never
 * synced" — most likely a signed-out device — and we fall back to showing every
 * home run rather than going silent.
 */
async function watchedIds() {
  try {
    const cache = await caches.open(VERSION);
    const res = await cache.match('watchlist');
    if (!res) return null;
    const { ids } = await res.json();
    return Array.isArray(ids) ? new Set(ids.map(String)) : null;
  } catch { return null; }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/** Keys already shown, so a duplicate push can't double-notify. */
async function seenKeys() {
  try {
    const cache = await caches.open(VERSION);
    const res = await cache.match('seen');
    return res ? new Set(await res.json()) : new Set();
  } catch { return new Set(); }
}
async function rememberKey(key) {
  try {
    const cache = await caches.open(VERSION);
    const seen = await seenKeys();
    seen.add(key);
    const trimmed = [...seen].slice(-300);
    await cache.put('seen', new Response(JSON.stringify(trimmed)));
  } catch {}
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let hrs = [];

    // A payload is optional — use it if the sender included one, otherwise
    // fetch. cache:'no-store' matters here or we'd re-show a stale homer.
    try {
      if (event.data) {
        const parsed = event.data.json();
        hrs = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch {}

    if (!hrs.length) {
      try {
        const res = await fetch(LATEST_URL + '?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          hrs = data.homeRuns || [];
        }
      } catch {}
    }

    if (!hrs.length) return;   // nothing to say — stay silent rather than show a placeholder

    const seen = await seenKeys();
    let fresh = hrs.filter(h => h.key && !seen.has(h.key)).slice(-5);

    // Narrow to the watch list. latest-hr.json is a single global file shared by
    // every device, so this per-device filter is what turns a league-wide feed
    // into "only the players I follow".
    const watched = await watchedIds();
    if (watched) {
      const mine = fresh.filter(h => h.batterId != null && watched.has(String(h.batterId)));
      // We subscribed with userVisibleOnly:true, so a push MUST produce a
      // visible notification — if we show nothing the browser substitutes its own
      // "site updated in the background" message and repeated offences can cost
      // us the subscription. The sender only wakes a device when that user
      // watches someone in this batch, so an empty result here means the batch
      // moved on before we fetched. Fall back to the newest home run instead of
      // going silent.
      fresh = mine.length ? mine : fresh.slice(-1);
    }

    for (const hr of fresh) {
      const bits = [];
      if (hr.exitVelo) bits.push(`${hr.exitVelo} mph`);
      if (hr.distance) bits.push(`${hr.distance} ft`);
      if (hr.launchAngle != null) bits.push(`${hr.launchAngle}°`);

      await self.registration.showNotification(`💣 ${hr.batter} — HOME RUN`, {
        body: [bits.join(' · '), `${hr.half} ${hr.inning} · ${hr.battingTeam} vs ${hr.opponent}`]
                .filter(Boolean).join('\n'),
        icon: ICON,
        badge: ICON,
        tag: hr.key,
        data: { url: 'index.html' },
        vibrate: [200, 100, 200],
      });
      await rememberKey(hr.key);
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing tab rather than piling up new ones. Matching on
    // 'index.html' used to miss every real visit: the site is served from the
    // bare origin (https://dingerwatch.app/) so an open tab's URL contains no
    // such segment, and tapping a notification opened a duplicate window on top
    // of the app the user already had. Compare against the worker's scope.
    const scope = self.registration.scope;
    for (const c of all) {
      if (c.url.startsWith(scope) && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(event.notification.data?.url || './');
  })());
});

/**
 * Chrome may rotate a subscription; re-subscribe so alerts don't silently stop.
 *
 * This previously POSTed the new subscription to `self.__DW_PUSH_API || ''` —
 * a variable that was never assigned anywhere in the codebase, so it always
 * POSTed to the empty string. That resolves against the worker's scope, i.e.
 * the site root on GitHub Pages, which is a static host that accepts no POSTs.
 * Every rotation therefore silently discarded the new subscription and that
 * device stopped receiving pushes permanently.
 *
 * There is no HTTP endpoint to post to — subscriptions live in Supabase and
 * writing to them needs the user's session, which a worker doesn't have. So
 * stash the new subscription in the cache and let the page persist it on next
 * open; boot() calls ensurePushRegistered, which re-saves and clears it.
 */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      // Reuse the old options so the VAPID applicationServerKey carries over.
      // Subscribing with only { userVisibleOnly: true } — the old fallback —
      // is rejected outright by Chrome, which requires an applicationServerKey.
      const opts = event.oldSubscription?.options;
      const sub = event.newSubscription || (opts
        ? await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: opts.applicationServerKey,
          })
        : null);
      if (!sub) return;
      const cache = await caches.open(VERSION);
      await cache.put('pending-subscription', new Response(JSON.stringify(sub.toJSON())));
      // Tell any open tab to persist it right now.
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      all.forEach(c => c.postMessage({ type: 'push-subscription-changed' }));
    } catch {}
  })());
});
