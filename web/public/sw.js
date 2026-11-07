// Offline shell for the installable app. API and WebSocket traffic (another origin) is never cached.
const CACHE = "listas-v2";
const SHELL = ["/", "/list/", "/auth/callback/", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // Pages: network first so deploys show up immediately; cached copy when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.pathname, copy));
          return res;
        })
        .catch(() => caches.match(url.pathname).then((r) => r ?? caches.match("/"))),
    );
    return;
  }

  // Hashed build assets never change; everything else is refreshed in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
      if (cached && url.pathname.startsWith("/_next/static/")) return cached;
      return cached ?? network;
    }),
  );
});

// Web Push from the API (api/src/push.rs): { title, body, url, tag }. Browsers require every push
// to show a notification, so there is no silent path. One tag per list: a burst of adds replaces
// the previous notification instead of piling up.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Listas", {
      body: data.body,
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      lang: "pt-BR",
      data: { url: data.url || "/" },
    }),
  );
});

// Focuses a window already on that list, else reuses any open window, else opens one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((w) => w.url === url);
      if (exact) return exact.focus();
      for (const w of windows) {
        try {
          await w.focus();
          return await w.navigate(url);
        } catch {
          // Not controlled by this worker (navigate throws); try the next one or open a window.
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
