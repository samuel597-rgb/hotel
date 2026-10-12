const CACHE = 'sams-hotel-sqlite-v7';
const APP_CACHE_PREFIX = 'sams-hotel-';
const ASSETS = [
  '/', '/app/', '/auth.html', '/auth.js', '/styles.css', '/icons/logo-192.png', '/icons/logo-512.png', '/icons/logo-180.png',
  '/local-api.js', '/local-auth.js', '/local-data.js', '/app.js',
  '/receipt.js', '/settings-behaviors.js', '/db-service.js',
  '/reset-password.html', '/runtime-config.js', '/manifest.json', '/food/1.jpg', '/food/2.jpg', '/food/3.jpg', '/food/4.jpg'
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
  // Public menu reads can come from the same host or a separately hosted API.
  const params = new URLSearchParams(url.search);
  const isOfflineCatalogRead = (
    url.pathname === '/api/products'
    || url.pathname === '/api/categories'
    || (url.pathname === '/api/records' && ['products', 'categories'].includes(params.get('path')))
    || (url.pathname === '/api/records' && params.get('path') === 'settings' && params.get('id') === 'general')
  );
  if (isOfflineCatalogRead) {
    const network = fetch(request).then(async response => {
      if (response.ok) await caches.open(CACHE).then(cache => cache.put(request, response.clone())).catch(() => {});
      return response;
    });
    event.waitUntil(network.then(() => {}).catch(() => {}));
    event.respondWith((async () => (await caches.match(request)) || network)());
    return;
  }

  if (url.origin !== self.location.origin) {
    const staticCdn = (url.hostname === 'cdn.jsdelivr.net'
      && (url.pathname.startsWith('/npm/chart.js') || url.pathname.startsWith('/npm/alpinejs')))
      || url.hostname === 'cdn.tailwindcss.com' || url.hostname === 'esm.sh';
    const menuImage = url.hostname === 'images.unsplash.com' && request.destination === 'image';
    if (!staticCdn && !menuImage) return;
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(async response => {
      if (response.ok || response.type === 'opaque') {
        await caches.open(CACHE).then(cache => cache.put(request, response.clone())).catch(() => {});
      }
      return response;
    })));
    return;
  }

  if (['/login','/portal','/api/staff/login','/admin','/staff','/employee','/display'].includes(url.pathname)
      || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/staff/')) return;

  // Authentication, order, and private API responses are never cached.
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
