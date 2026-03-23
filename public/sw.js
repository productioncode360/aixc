const CACHE = "mcq-v1.0";
const ASSETS = [
  "/public",               // Main route
  "/manifest.json",        // Manifest file
  "/icon-192.png",         // Icons
  "/icon-512.png"
];

// Install Event
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      console.log("Caching assets...");
      return c.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate Event (Purana cache saaf karne ke liye)
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch Event (Offline support ke liye)
self.addEventListener("fetch", e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});