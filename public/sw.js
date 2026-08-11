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
    const fresh = hrs.filter(h => h.key && !seen.has(h.key)).slice(-5);

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
    // Focus an existing tab rather than piling up new ones.
    for (const c of all) {
      if (c.url.includes('index.html') && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(event.notification.data?.url || 'index.html');
  })());
});

/** Chrome may drop a subscription; re-subscribe so alerts don't silently stop. */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const sub = await self.registration.pushManager.subscribe(
        event.oldSubscription?.options || { userVisibleOnly: true });
      await fetch(self.__DW_PUSH_API || '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      });
    } catch {}
  })());
});
