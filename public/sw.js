// ═══════════════════════════════════════════════════════════════
//  MCQ Quiz Portal — Service Worker  v3.0
//  Fix: App shell cached properly + IDB-aware messages
// ═══════════════════════════════════════════════════════════════

const CACHE_STATIC = "mcq-static-v3.0";
const CACHE_API    = "mcq-api-v3.0";

// ── App shell: ye sab turant available hone chahiye ────────────
const SHELL_ASSETS = [
  "/public",            // main HTML page
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// ── Ye APIs stale-while-revalidate cache hongi ─────────────────
const API_CACHE_PATTERNS = [
  "/api/public/subjects",
  "/api/public/topics/",
  "/api/public/news-quiz",
  "/api/public/news-articles",
  "/api/news",
  "/api/notifications",
];

// ══════════════════════════════════════════════════════════════
//  INSTALL — shell assets eagerly cache karo
// ══════════════════════════════════════════════════════════════
self.addEventListener("install", e => {
  console.log("[SW v3.0] Installing...");
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      // addAll fails silently agar ek bhi fail ho, isliye individually try karo
      return Promise.allSettled(
        SHELL_ASSETS.map(url =>
          fetch(url, { cache: "no-store" })
            .then(res => {
              if (res.ok) {
                console.log("[SW] Cached:", url);
                return cache.put(url, res);
              }
            })
            .catch(err => console.warn("[SW] Cache miss:", url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ══════════════════════════════════════════════════════════════
//  ACTIVATE — purana cache hatao
// ══════════════════════════════════════════════════════════════
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC && k !== CACHE_API)
          .map(k => {
            console.log("[SW] Deleting old cache:", k);
            return caches.delete(k);
          })
      )
    )
  );
  self.clients.claim();
});

// ══════════════════════════════════════════════════════════════
//  FETCH — smart routing
// ══════════════════════════════════════════════════════════════
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Socket.io — kabhi intercept mat karo
  if (url.pathname.startsWith("/socket.io")) return;

  // POST/PUT/DELETE — seedha network
  if (e.request.method !== "GET") {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: "offline" }), {
        headers: { "Content-Type": "application/json" }
      })
    ));
    return;
  }

  // API routes — Stale While Revalidate
  const isApiRoute = API_CACHE_PATTERNS.some(p => url.pathname.startsWith(p));
  if (isApiRoute) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_API));
    return;
  }

  // Main HTML page (/public) — Cache First, network fallback
  if (url.pathname === "/public" || url.pathname === "/public/") {
    e.respondWith(
      caches.match("/public", { cacheName: CACHE_STATIC }).then(cached => {
        if (cached) {
          // Background mein fresh version bhi fetch karo
          fetch(e.request, { cache: "no-store" })
            .then(res => {
              if (res && res.ok) {
                caches.open(CACHE_STATIC).then(c => c.put("/public", res.clone()));
              }
            })
            .catch(() => {});
          return cached;
        }
        // Cache miss — network se lo
        return fetch(e.request).catch(() =>
          new Response("<h1>Offline</h1><p>Quiz Portal offline hai. Internet check karo.</p>", {
            headers: { "Content-Type": "text/html" }
          })
        );
      })
    );
    return;
  }

  // Static assets (icons, manifest) — Cache First
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type !== "opaque") {
          const clone = res.clone();
          caches.open(CACHE_STATIC).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => null);
    })
  );
});

// ══════════════════════════════════════════════════════════════
//  STALE WHILE REVALIDATE
//  1. Cache se turant do
//  2. Network background mein fetch karo
//  3. Fresh data aaya → cache update + clients ko notify karo
// ══════════════════════════════════════════════════════════════
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request, { cache: "no-store" })
    .then(async res => {
      if (res && res.status === 200) {
        await cache.put(request, res.clone());

        // Sabhi open tabs ko batao — fresh data aa gaya
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach(client => {
          client.postMessage({
            type: "SW_DATA_UPDATED",
            url: request.url,
          });
        });
      }
      return res;
    })
    .catch(() => null);

  // Cache available → turant return karo, network background mein
  if (cached) return cached;

  // First load — network ka wait karo
  const networkRes = await networkFetch;
  if (networkRes) return networkRes;

  // Dono fail → offline response
  return new Response(
    JSON.stringify({ error: "offline", cached: false }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" }
    }
  );
}

// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER — client se messages
// ══════════════════════════════════════════════════════════════
self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  // Client ne IDB mein data save kiya — acknowledge karo
  if (e.data?.type === "IDB_READY") {
    console.log("[SW] Client IDB ready, subjects:", e.data.subjectCount);
  }
});
