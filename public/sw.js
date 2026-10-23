'use strict';

// Offline tartalék a játék felületéhez. Mindig a hálózat az első: így egy frissítés után azonnal
// az új felület és kód töltődik be. A tárolt példányt csak akkor használjuk, ha a hálózat nem
// válaszol (gyenge térerő, kiesés). Az /api, a kapu és a szervezői oldalak sosem tárolódnak.
const CACHE = 'atlantis-v7';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/app.js', '/js/ocean.js', '/fonts/fonts.css'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  // Egyenként töltjük: ha egy fájl hiányzik, a többi még bekerül, és a telepítés nem bukik el
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/^\/(api|kapu|adatvedelem|ranglista|admin|healthz)(\/|$)/.test(url.pathname)) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fromNetwork(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      } catch {
        const cached = await cache.match(event.request);
        return cached || Response.error();
      }
    })
  );
});
