/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

// Custom service worker (vite-plugin-pwa `injectManifest` strategy). Replaces the auto-generated
// `generateSW` worker this project used before — that mode has no room for custom code, which is
// exactly what a push notification handler is. Everything below is either (a) rebuilding what
// `generateSW` used to do automatically (precaching the app shell, the SPA navigation fallback,
// the SKIP_WAITING message this project's `registerType: 'prompt'` update flow depends on —
// UpdatePrompt.tsx/useRegisterSW), so Technical_Debt_Plan.md TD-04's offline/update behaviour
// doesn't regress, or (b) the actual new capability this file exists for: `push` /
// `notificationclick`. API/socket traffic is still never precached or intercepted — no route
// below matches /api or /socket.io, same as the old `navigateFallbackDenylist`.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope;

// Injected at build time by vite-plugin-pwa with the list of built assets + revision hashes —
// the direct equivalent of generateSW's own globPatterns-driven precache list.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA fallback: any navigation not otherwise precached (e.g. a deep link like /route/:token,
// or /household, /collector, /admin on first load) resolves to the cached app shell instead of a
// network 404 — mirrors the old generateSW config's implicit navigateFallback, still excluding
// /api and /socket.io so neither ever gets served a cached HTML page by mistake.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/socket\.io\//],
  })
);

// registerType: 'prompt' (vite.config.ts) means a waiting worker never takes over on its own —
// UpdatePrompt.tsx's "Update" button calls updateServiceWorker(true), which (via workbox-window,
// used internally by virtual:pwa-register) posts exactly this message to the waiting worker.
// Without this listener, clicking "Update" would just hang forever waiting for a SW that never
// activates.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// --------------------------------------------------------------- Web Push (new capability)

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
}

/**
 * The actual gap this whole feature exists to close: emitToUser() (Socket.IO) only reaches a
 * client with the tab open and connected. A `push` event fires here even with every Borla tab
 * closed or the phone locked — this is what turns server/src/notify.ts's push half into an OS
 * notification tray entry instead of nothing at all.
 */
self.addEventListener("push", (event) => {
  let payload: PushPayload = { title: "Borla", body: "You have a new notification" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Not JSON (shouldn't happen — server always sends JSON.stringify'd PushPayload) — fall back
    // to the plain-text body rather than dropping the notification entirely.
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    })
  );
});

/** Tapping the notification focuses an already-open Borla tab if one exists, rather than always
 *  opening a new one — a collector likely already has the app open in the background. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
