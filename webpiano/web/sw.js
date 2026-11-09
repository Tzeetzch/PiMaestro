/* PiMaestro service worker (serves both the game at / and the remote at /remote).
   Network-FIRST (controls + live SSE must always hit the Pi);
   the cache is only an offline fallback for the static shell. Registers only on a secure
   context (HTTPS / localhost) — over plain http on the LAN the page still works, just not
   as an installable PWA. */
const CACHE = 'pimaestro-v63';
const SHELL = ['/', '/index.html', '/app.js', '/session.js', '/render.js', '/sound.js', '/sse.js', '/catalog.js', '/pilib.js', '/nav.js', '/transport.js', '/setup.js', '/vendor/webaudio-tinysynth.js', '/vendor/js-synthesizer.min.js', '/vendor/libfluidsynth-2.4.6.js',
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
  const u = new URL(e.request.url);
  // Live API answers (song lists, settings, devices) must come from the Pi, and caching them only
  // wrote to the SD card on every request (one /settings entry per song, never pruned).
  if (u.origin === location.origin && /^\/(songs|library|settings|devices|song|halt)(\/|$)/.test(u.pathname)) return;
  // Instrument samples, vendored libraries and soundfonts never change: cache-FIRST, so a reload
  // doesn't re-download ~12 MB and rewrite the cache each time.
  if (/\/(waf|vendor|sf)\//.test(u.pathname)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
      return resp;
    })));
    return;
  }
  // The app shell: network-first (a deploy shows at once), the cache is the offline fallback.
  e.respondWith(
    fetch(e.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
      return resp;
    }).catch(() => caches.match(e.request))
  );
});