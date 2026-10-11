const CACHE = 'sams-hotel-v8';
const APP_CACHE_PREFIX = 'sams-hotel-';
const ASSETS = [
  '/', '/app/', '/auth.html', '/auth.js', '/styles.css',
  '/supabase.js', '/supabase-auth.js', '/supabase-data.js', '/app.js',
  '/receipt.js', '/auth-extra.js', '/settings-behaviors.js', '/db-service.js',
  '/reset-password.html', '/runtime-config.js', '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    const staticCdn = (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/chart.js'))
      || url.hostname === 'cdn.tailwindcss.com' || url.hostname === 'esm.sh';
    if (!staticCdn) return;
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    })));
    return;
  }

  // Authentication settings and API responses must always be fetched live.
  if (url.pathname.startsWith('/api/') || url.pathname === '/runtime-config.json') return;

  if (request.destination === 'script' || /\.js$/i.test(url.pathname)) {
    event.respondWith(fetch(request, { cache: 'no-cache' }).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match(request, { ignoreSearch: true })) || Response.error()));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-cache' }).then(response => {
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
    }));
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => Response.error())));
});
