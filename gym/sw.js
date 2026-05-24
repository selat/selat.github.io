/* ════════════════════════════════════════════════════════════════════
   SW.JS — Service worker for /gym/
   ════════════════════════════════════════════════════════════════════
   Cache-first within scope; bump CACHE_VERSION on every deploy that
   changes any cached file. JetBrains Mono is loaded from Google Fonts
   and lazy-cached on first fetch.
   ════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'gym-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './theme.css',
  './styles.css',
  './app.js',
  './data/storage.js',
  './data/exercises.js',
  './data/muscles.js',
  './data/sessions.js',
  './data/recovery.js',
  './data/templates.js',
  './data/derived.js',
  './data/seed-demo.js',
  './ui/home.js',
  './ui/record.js',
  './ui/session.js',
  './ui/workout.js',
  './ui/library.js',
  './ui/history.js',
  './ui/body.js',
  './ui/settings.js',
  './ui/shared.js',
  './assets/body-front.svg',
  './assets/body-back.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './icon-apple-180.png',
];


self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});


self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});


self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // Also cache JetBrains Mono from Google Fonts so we work offline.
  const isFont = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
