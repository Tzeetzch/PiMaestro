/* PiMaestro service worker (serves both the game at / and the remote at /remote).
   Network-FIRST (controls + live SSE must always hit the Pi);
   the cache is only an offline fallback for the static shell. Registers only on a secure
   context (HTTPS / localhost) — over plain http on the LAN the page still works, just not
   as an installable PWA. */
const CACHE = 'pimaestro-v11';
const SHELL = ['/', '/index.html', '/app.js', '/render.js', '/sound.js', '/sse.js', '/catalog.js', '/pilib.js', '/nav.js', '/transport.js', '/setup.js', '/vendor/webaudio-tinysynth.js',
  '/remote', '/remote.html', '/app.webmanifest', '/remote.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-app-192.png', '/icon-app-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;            // never touch POST /control
  if (e.request.url.includes('/events')) return;     // leave the SSE stream alone (don't buffer it)
  // network-first, but cache every successful GET (incl. on-demand WebAudioFont instrument files
  // from the CDN) so the second load — and offline — works from cache.
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
