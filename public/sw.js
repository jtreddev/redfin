// App-shell service worker. Never caches /api (your data) or Cloudflare Access login pages.
const CACHE = 'fin-shell-v2';

/**
 * Caches the app shell ('/') and the built files it loads, so the first offline launch after an update
 * works (activating a new CACHE deletes the old one, shell included). Same guard as navigations: only a
 * plain same-origin 200 that wasn't redirected, so a Cloudflare Access sign-in page is never cached; and
 * only a page that is really the app (it has the #root mount). The shell goes in after its files.
 */
async function precacheShell(cache) {
  const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!(response.ok && response.type === 'basic' && !response.redirected)) return;
  const html = await response.clone().text();
  if (!html.includes('id="root"')) return;
  const files = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) ?? [])];
  await cache.addAll(files);
  await cache.put('/', response);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(['/manifest.webmanifest', '/icon.svg', '/fonts/PublicSans-Variable.woff2']).catch(() => undefined);
      // Best effort: without it, the shell is cached on the next online launch as before.
      await precacheShell(cache).catch(() => undefined);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;

  if (request.mode === 'navigate') {
    // Network first so a fresh deploy or an Access sign-in always wins; cached shell when offline.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok && response.type === 'basic' && !response.redirected) {
            const cache = await caches.open(CACHE);
            await cache.put('/', response.clone());
          }
          return response;
        } catch {
          return (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    // Built assets have content hashes in their names, so cache-first is safe. The font has no hash: a new
    // font file needs a new CACHE name (which clears the old one on activate).
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});
