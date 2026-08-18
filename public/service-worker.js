// Bump this whenever the cached shell needs to be thrown away.
const CACHE_NAME = "smartscan-shell-v45";

// Only unversioned paths belong here. Listing "?v=..." URLs pinned the cache to
// one release: every deploy left them pointing at a stale build, and because
// cache.addAll() rejects atomically a single missing entry failed the whole
// service-worker install.
const SHELL_ASSETS = ["/", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache each asset independently so one failure cannot abort the install.
      Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/")) return;
  // The admin panel is a separate app served at /admin — never let the customer
  // PWA cache/serve it (otherwise /admin can fall back to the cached landing page).
  if (requestUrl.pathname === "/admin" || requestUrl.pathname.startsWith("/admin/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only store successful same-origin responses; caching an error page is
        // what made a stale shell reappear on later loads.
        if (response.ok && requestUrl.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/")))
  );
});
