// Service worker: lets the app install and open offline (the shell only; chats always need the network).
// Network first for our own static files, so a deploy shows up on the next open; the cache is only the fallback.
const CACHE = "choco-harness-shell-v1";
const SHELL = ["/", "/tokens.css", "/app.css", "/js/app.js", "/js/md.js", "/js/sse.js", "/js/icons.js", "/js/turn.js", "/js/anim.js", "/js/theme.js", "/js/attach.js",
  "/vendor/motion.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/mark.svg", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname.startsWith("/manage/")) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then((r) => r || (e.request.mode === "navigate" ? caches.match("/") : Response.error()))));
});
