const CACHE_NAME = 'cb-butchers-shell-20261108-v4';
const CORE_ASSETS = [
  './',
  './index.html',
  './stats.html',
  './styles.css',
  './stats.css',
  './app.js',
  './stats.js',
  './pwa.js',
  './site.webmanifest',
  './config/config.json',
  './favicon.ico',
  './assets/cb-butchers-logo.png',
  './assets/favicon-32.png',
  './assets/favicon-192.png',
  './assets/favicon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      CORE_ASSETS.map(url => cache.add(new Request(url, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('cb-butchers-shell-') && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // API and all external data sources stay network-only so attendance,
  // events, results and standings are never served from an old SW cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await networkFirst(request);
      } catch (error) {
        const cache = await caches.open(CACHE_NAME);
        if (url.pathname.endsWith('/stats.html')) {
          return (await cache.match('./stats.html')) || Response.error();
        }
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  if (['script', 'style', 'worker'].includes(request.destination)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (['image', 'font'].includes(request.destination)) {
    event.respondWith(cacheFirst(request));
  }
});
