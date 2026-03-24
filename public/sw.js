// ── Cache names — version badlo toh purana cache automatically hatega ─────────
const CACHE_STATIC = "mcq-static-v2.0";
const CACHE_API    = "mcq-api-v2.0";

// ── App shell — ye sab INSTALL pe cache honge ────────────────────────────────
const ASSETS = [
  "/public",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// ── API routes — stale-while-revalidate ──────────────────────────────────────
const API_CACHE_PATTERNS = [
  "/api/public/subjects",
  "/api/public/topics/",
  "/api/public/news-quiz",
  "/api/public/news-articles",
  "/api/news",
  "/api/notifications",
];

// INSTALL — app shell turant cache karo
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_STATIC).then(async cache => {
      console.log("[SW] Installing & caching app shell...");
      for (const asset of ASSETS) {
        try {
          await cache.add(asset);
          console.log("[SW] Cached:", asset);
        } catch(err) {
          console.warn("[SW] Failed to cache:", asset, err);
        }
      }
    })
  );
  self.skipWaiting();
});

// ACTIVATE — purana cache saaf karo
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => { console.log("[SW] Deleting old cache:", k); return caches.delete(k); })
      )
    ).then(() => { console.log("[SW] Activated"); return self.clients.claim(); })
  );
});

// FETCH — smart routing
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Socket.io — SW handle nahi karega
  if (url.pathname.startsWith("/socket.io")) return;

  // POST/PUT/DELETE — seedha network
  if (e.request.method !== "GET") {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: "offline" }), { headers: { "Content-Type": "application/json" } })
    ));
    return;
  }

  // API routes — Stale While Revalidate
  const isApi = API_CACHE_PATTERNS.some(p => url.pathname.startsWith(p));
  if (isApi) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // App shell & static — CACHE FIRST (key fix!)
  e.respondWith(cacheFirst(e.request, url));
});

// CACHE FIRST — Render cold hoga toh bhi app instantly open hogi
async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE_STATIC);
  const cached = await cache.match(request);

  if (cached) {
    // Background mein silently update
    fetch(request).then(res => {
      if (res && res.status === 200 && res.type !== "opaque") cache.put(request, res.clone());
    }).catch(() => {});
    return cached;
  }

  // Cache miss — network se lo
  try {
    const res = await fetch(request);
    if (res && res.status === 200 && res.type !== "opaque") cache.put(request, res.clone());
    return res;
  } catch(err) {
    const fallback = await cache.match("/public");
    if (fallback) return fallback;
    return new Response("App offline", { status: 503 });
  }
}

// STALE WHILE REVALIDATE — API data ke liye
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_API);
  const cached = await cache.match(request);

  const networkPromise = fetch(request).then(async res => {
    if (res && res.status === 200) {
      await cache.put(request, res.clone());
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach(client => client.postMessage({ type: "SW_DATA_UPDATED", url: request.url }));
    }
    return res;
  }).catch(() => null);

  if (cached) return cached;

  const networkRes = await networkPromise;
  if (networkRes) return networkRes;

  return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
}
