/**
 * Offline support for the composer. Everything the app needs is static:
 * pages/scripts are hashed (cache-first), and the daily data snapshots are
 * network-first so a connected client always sees fresh numbers while an
 * offline one falls back to the last cached copy.
 */

const CACHE = "mrtc-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const isData = /\/data\/(snapshot|pairs)\.json$/.test(url.pathname);
  if (req.mode === "navigate" || isData) {
    // network-first: fresh app shell + data online, cached copy offline
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req, { ignoreSearch: req.mode === "navigate" })
            .then((hit) => hit ?? Response.error()),
        ),
    );
    return;
  }

  // hashed static assets: cache-first
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
