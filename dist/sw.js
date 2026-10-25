/* Optional offline app shell. The barcode batch remains in device-local storage. */
const CACHE = 'pocketscan-static-v13';
const SHELL = ['./', './index.html', './styles.css', './app.js', './scanner.js', './decoder.js', './decode-worker.js', './media.js', './icon.svg', './manifest.webmanifest', './vendor/zxing.min.js'];

// GitHub Pages lets browsers reuse files for 10 minutes, so bypass that HTTP cache: precache fresh
// copies, and revalidate every request (an unchanged file costs only a 304 response).
self.addEventListener('install', (event) => {
  const fresh = SHELL.map((path) => new Request(path, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('pocketscan-static-') && key !== CACHE).map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    // A navigation request cannot be copied with new options, so fetch its URL instead.
    event.respondWith(fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => caches.match('./index.html')));
    return;
  }
  event.respondWith(fetch(new Request(event.request, { cache: 'no-cache' })).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
