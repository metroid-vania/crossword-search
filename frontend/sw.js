/* クロスワード辞典 Service Worker
 * 戦略:
 *   - 同一オリジンの静的 GET: Stale-While-Revalidate
 *   - api.php: Network Only（キャッシュしない）
 *   - クロスオリジン: 介入しない
 */
const VERSION = '2026042004';
const CACHE_NAME = `findword-cache-${VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/help.html',
  '/privacy.html',
  `/style.css?v=${VERSION}`,
  `/app.js?v=${VERSION}`,
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('findword-cache-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // クロスオリジンは介入しない
  if (url.pathname.endsWith('/api.php')) return;             // API はネットワーク直

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: false });
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const net = await networkPromise;
  if (net) return net;
  // オフラインかつキャッシュ無し: ナビゲーションなら index.html で代替
  if (req.mode === 'navigate') {
    const fallback = await cache.match('/index.html');
    if (fallback) return fallback;
  }
  return new Response('', { status: 504, statusText: 'offline' });
}
