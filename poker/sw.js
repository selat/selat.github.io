/* ════════════════════════════════════════════════════════════════════
   SW.JS — Service worker for /poker/
   ════════════════════════════════════════════════════════════════════
   Strategy: precache the entire app (shell + icons + ML model + ORT
   runtime) on install, then cache-first for every request in scope.
   Cross-origin requests outside the pinned ORT base are passed through
   untouched.

   Updates: bump CACHE_VERSION on every deploy that changes any cached
   file. The new SW takes over immediately via skipWaiting + claim, and
   old caches are deleted on activate. There's a one-load lag for tabs
   that were already open at update time — they'll see the new content
   on next navigation.
   ════════════════════════════════════════════════════════════════════ */


const CACHE_VERSION = 'cgc-v3';

// Pin ORT version — must match the <script src=…> in chips.html and
// the wasmPaths set in chips.js. Changing the version requires bumping
// CACHE_VERSION above so the new wasm files get fetched.
const ORT_VER  = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;

// App shell — small, must succeed on install.
const APP_SHELL = [
  './',
  './index.html',
  './chips.html',
  './app.js',
  './chips.js',
  './theme.css',
  './styles.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './icon-apple-180.png',
];

// Heavy assets — best-effort. If any fail (CDN hiccup, offline at install),
// we still install the SW; missing items are filled in lazily by the fetch
// handler the first time they're requested with a network connection.
const HEAVY = [
  './model.onnx',
  ORT_BASE + 'ort.min.js',
  // ORT picks a wasm variant at runtime based on browser capabilities.
  // We precache the common variants so most browsers go fully offline:
  //   - WebGPU (JSEP) build for Chrome/Edge with WebGPU
  //   - SIMD+threaded fallback for Safari and no-WebGPU Chrome
  ORT_BASE + 'ort-wasm-simd-threaded.jsep.wasm',
  ORT_BASE + 'ort-wasm-simd-threaded.jsep.mjs',
  ORT_BASE + 'ort-wasm-simd-threaded.wasm',
  ORT_BASE + 'ort-wasm-simd-threaded.mjs',
];


/* ── Install: precache everything ─────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // App shell must succeed — if any of these 404, we want install to fail
    // so a half-broken SW doesn't stick around.
    await cache.addAll(APP_SHELL);
    // Heavy assets are best-effort.
    await Promise.allSettled(
      HEAVY.map((url) => cache.add(new Request(url, { mode: 'cors' })))
    );
    // Take over without waiting for all tabs to close.
    await self.skipWaiting();
  })());
});


/* ── Activate: drop old caches, claim clients ─────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});


/* ── Fetch: cache-first within scope, pass-through otherwise ──────── */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isOrt = req.url.startsWith(ORT_BASE);

  // Don't intercept anything outside our scope or the pinned ORT base —
  // lets the rest of selat.github.io and unrelated cross-origin requests
  // behave normally.
  if (!sameOrigin && !isOrt) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      // Lazy-cache successful responses we'd want offline next time.
      // (Opaque responses have status 0 — only cache real successes.)
      if (res && res.ok) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      // Offline navigation: serve the app shell so the route renders
      // something instead of the browser's offline page.
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
