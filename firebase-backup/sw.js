importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

const CACHE = 'sams-hotel-v7';
const APP_CACHE_PREFIX = 'sams-hotel-';
const ASSETS = [
  '/', '/app/', '/auth.html', '/auth.js', '/styles.css',
  '/firebase.js', '/app.js', '/receipt.js', '/auth-extra.js',
  '/settings-behaviors.js', '/db-service.js', '/reset-password.html',
  '/runtime-config.js', '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    // Cache static Firebase SDK and UI CDN scripts after their first online load.
    const staticCdn = (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))
      || (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/chart.js'))
      || url.hostname === 'cdn.tailwindcss.com';
    if (!staticCdn) return;

    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(response => {
        if (response.ok || response.type === 'opaque') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }))
    );
    return;
  }

  // Always refresh same-origin JavaScript while online. Older releases kept
  // modules cache-first, which could mix new HTML with stale module exports
  // and prevent the entire auth UI from starting.
  if (request.destination === 'script' || /\.js$/i.test(url.pathname)) {
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match(request, { ignoreSearch: true })) || Response.error())
    );
    return;
  }

  // Never cache Firebase APIs, function calls, or Firebase Hosting internals.
  if (url.pathname.startsWith('/__/') || /firestore|googleapis|identitytoolkit|securetoken|firebasestorage|cloudfunctions/i.test(url.hostname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-cache' }).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(async () => {
        const exact = await caches.match(request);
        if (exact) return exact;
        if (url.pathname.startsWith('/app')) return (await caches.match('/app/')) || (await caches.match('/'));
        return (await caches.match('/')) || (await caches.match('/app/'));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => Response.error()))
  );
});

firebase.initializeApp({
  authDomain: 'hoteli-cd840.firebaseapp.com',
  projectId: 'hoteli-cd840',
  storageBucket: 'hoteli-cd840.firebasestorage.app',
  messagingSenderId: '519879537315',
  appId: '1:519879537315:web:fe10a4698cafe6ab990516'
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const notification = payload.notification || {};
  return self.registration.showNotification(notification.title || "HOTELI POA", {
    body: notification.body || '',
    data: payload.data || {}
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const requestedPath = event.notification.data?.url;
  let target = new URL('/app/', self.location.origin);
  if (typeof requestedPath === 'string') {
    try {
      const requestedUrl = new URL(requestedPath, self.location.origin);
      if (requestedUrl.origin === self.location.origin) target = requestedUrl;
    } catch {}
  }

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
    const existing = windowClients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing && existing.url !== target.href) {
        return existing.navigate(target.href).then(client => (client || existing).focus());
      }
      return existing.focus();
    }
    return self.clients.openWindow(target.href);
  }));
});
