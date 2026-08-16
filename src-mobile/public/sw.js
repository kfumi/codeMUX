const CACHE_NAME = 'codemux-mobile-v3';

function isApiRequest(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/manifest.json', '/icon.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApiRequest(url)) {
    return;
  }

  // Always prefer network so companion UI updates ship without stale bundles.
  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((response) => response)
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          return new Response('桌面端离线，请重新打开移动伴侣。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        throw new Error('offline');
      }),
  );
});
