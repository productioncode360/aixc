const CACHE_STATIC = "mcq-static-v1.1";
const CACHE_API    = "mcq-api-v1.1";

// Static assets — app shell
const ASSETS = [
  "/public",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// Ye APIs cache hongi (stale-while-revalidate)
const API_CACHE_PATTERNS = [
  "/api/public/subjects",
  "/api/public/topics/",
  "/api/public/news-quiz",
  "/api/public/news-articles",
  "/api/news",
  "/api/notifications",
];

// ── Install — static assets cache karo ───────────────────────────────────────
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_STATIC).then(c => {
      console.log("[SW] Static assets caching...");
      return c.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate — purana cache hatao ────────────────────────────────────────────
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => {
            console.log("[SW] Old cache deleted:", k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch — smart routing ─────────────────────────────────────────────────────
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Socket.io — kabhi cache mat karo
  if (url.pathname.startsWith("/socket.io")) {
    return;
  }

  // POST requests (quiz fetch, chat, save) — cache nahi, seedha network
  if (e.request.method !== "GET") {
    e.respondWith(fetch(e.request));
    return;
  }

  // API routes — Stale While Revalidate
  const isApiRoute = API_CACHE_PATTERNS.some(p => url.pathname.startsWith(p));
  if (isApiRoute) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_API));
    return;
  }

  // Static assets — Cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Sirf valid responses cache karo
        if (res && res.status === 200 && res.type !== "opaque") {
          const clone = res.clone();
          caches.open(CACHE_STATIC).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback — /public serve karo
        if (url.pathname.startsWith("/public")) {
          return caches.match("/public");
        }
      });
    })
  );
});

// ── Stale While Revalidate ────────────────────────────────────────────────────
// 1. Cache se turant do (agar hai)
// 2. Network se bhi fetch karo background mein
// 3. Network aaya → cache update + client ko notify karo
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Background fetch — chahe Render 20s le ya 60s
  const networkFetch = fetch(request).then(async res => {
    if (res && res.status === 200) {
      await cache.put(request, res.clone());
      // Sabhi open clients ko batao — fresh data aa gaya
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(client => {
        client.postMessage({
          type: "SW_DATA_UPDATED",
          url: request.url
        });
      });
    }
    return res;
  }).catch(() => null); // Render off hai — silently fail

  // Cached data hai → turant do, network background mein
  if (cached) {
    return cached;
  }

  // Cache nahi hai (first time) → network ka wait karo
  return networkFetch || new Response(
    JSON.stringify({ error: "offline", cached: false }),
    { headers: { "Content-Type": "application/json" } }
  );
}
