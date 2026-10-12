// Service worker za spletno različico (iOS/Android brskalnik, »Dodaj na začetni zaslon«).
// - aplikacija (HTML): najprej omrežje, sicer shranjena kopija
// - sredstva z zgoščeno vrednostjo v imenu, ikone in naše ploščice: iz predpomnilnika
// - podatki (data/*.json): takoj shranjena kopija, v ozadju osvežitev
// - ploščice podlage in terena (OpenFreeMap, Mapterhorn): enako, z omejitvijo števila

const SHELL = 'strmina-shell-v1';
const DATA = 'strmina-data-v1';
const TILES = 'strmina-tiles-v1';
const MAX_TILES = 3000;
const TILE_HOSTS = ['tiles.mapterhorn.com', 'tiles.openfreemap.org'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  const keep = new Set([SHELL, DATA, TILES]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL));
  } else if (url.origin === self.location.origin) {
    if (/\/(assets|tiles|icons)\//.test(url.pathname)) event.respondWith(cacheFirst(req, SHELL));
    else event.respondWith(staleWhileRevalidate(req, DATA));
  } else if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, TILES, MAX_TILES));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match('./')) || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

let puts = 0;
async function staleWhileRevalidate(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then(res => {
      if (res.ok) {
        cache.put(req, res.clone());
        if (max && ++puts % 100 === 0) trim(cache, max);
      }
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || update;
}

/** Najstarejše vnose izbriše, ko jih je več kot max (keys() so v vrstnem redu vstavljanja). */
async function trim(cache, max) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(k => cache.delete(k)));
}
