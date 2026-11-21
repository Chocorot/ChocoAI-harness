// Lets the app install and open offline (the shell only; chats always need the network).
// Network first, so a deploy shows on the next open; the cache is only the fallback. Never touches /api, /manage or /task.
const CACHE = 'choco-ai-shell-v3'
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (e) =>
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())),
)
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== location.origin || /^\/(api|manage|task)(\/|$)/.test(u.pathname)) return
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)) }
        return r
      })
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))),
  )
})
