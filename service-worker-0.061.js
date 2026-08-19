'use strict';

const CACHE_NAME = 'night-pallet-counter-0.061';
const APP_SHELL = [
  './',
  './index.html',
  './styles-0.061.css',
  './logic-0.061.js',
  './app-0.061.js',
  './manifest-0.061.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, fallbackKey = null) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.status === 200 && response.type !== 'opaque') {
      await cache.put(request, response.clone());
      if (fallbackKey) await cache.put(fallbackKey, response.clone());
    }
    return response;
  } catch (error) {
    return (await cache.match(request))
      || (fallbackKey ? await cache.match(fallbackKey) : null)
      || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, './index.html'));
    return;
  }

  const url = new URL(event.request.url);
  const coreNames = [
    '/styles-0.061.css',
    '/logic-0.061.js',
    '/app-0.061.js',
    '/manifest-0.061.json'
  ];
  const coreAsset = url.origin === self.location.origin
    && coreNames.some((name) => url.pathname.endsWith(name));

  if (coreAsset) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type !== 'opaque') {
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      }
      return response;
    }))
  );
});
