import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// ── Precaching ────────────────────────────────────────────────────────────────
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Runtime caching — Sheets API ──────────────────────────────────────────────
// SEC-05: cap cached financial data at 1 hour / 50 entries so it doesn't
// persist indefinitely if the user closes without signing out.
registerRoute(
  ({ url }) => url.origin === 'https://sheets.googleapis.com',
  new NetworkFirst({
    cacheName: 'sheets-api',
    networkTimeoutSeconds: 10,
    plugins: [
      new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 60 * 60 }),
    ],
  })
);

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// ── Background sync — drain offline queue when connectivity returns ───────────
self.addEventListener('sync', event => {
  if (event.tag !== 'budget-sync-expenses') return;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        client.postMessage({ type: 'DRAIN_OFFLINE_QUEUE' });
      }
    })
  );
});

// ── Push notification handler ─────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { data = { body: event.data?.text() }; }

  const title   = data.title || 'Budget Tracker';
  const options = {
    body:      data.body || 'Check your daily budget digest',
    icon:      '/icons/icon-192.png',
    badge:     '/icons/icon-192.png',
    tag:       'budget-digest',
    renotify:  false,
    silent:    false,
    data:      { url: (data.url?.startsWith(self.registration.scope) ? data.url : '/') },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification click — open / focus the app ─────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const target = list.find(c => c.url.startsWith(self.registration.scope));
      if (target) return target.focus();
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
