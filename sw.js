const CACHE = 'magdeburg-events-v1';
const ASSETS = [
  '/magdeburg-events/',
  '/magdeburg-events/index.html',
  '/magdeburg-events/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('fetch', e => {
  // events.json immer frisch laden
  if (e.request.url.includes('events.json')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
