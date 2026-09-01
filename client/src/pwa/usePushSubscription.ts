import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { urlBase64ToUint8Array } from "../utils/push";
import { isIOS, isStandalone, isSafari } from "../utils/platform";

/**
 * Real OS-level push notifications (closes the gap Socket.IO's emitToUser() alone can't — that
 * only reaches a tab that's open and connected right now). Explicit opt-in only: asks for
 * `Notification.requestPermission()` — a real browser permission prompt — only from a direct tap
 * on "Enable notifications" (see PushToggle.tsx), never automatically on load. Same "a stranger/
 * user deserves an informed prompt, not a surprise browser popup" philosophy already used for
 * geolocation (useGeolocation.ts) and RouteMeReceive's own "Locate me" button.
 *
 * iOS is a real, separate case, not just "another browser": Safari exposes `serviceWorker`/
 * `PushManager` in a plain tab (so the naive feature-detect below reports `supported: true`),
 * but Apple only actually delivers push to an installed, Home-Screen PWA (`display-mode:
 * standalone`) — a plain Safari tab's subscribe() call fails. Found live: this is exactly why it
 * worked on a laptop browser and silently didn't on an iPhone opened straight in Safari.
 * `needsIOSInstall` exists so the UI can say *why*, instead of a generic failure or (worse)
 * nothing at all.
 */
export function usePushSubscription() {
  const [supported] = useState(() => "serviceWorker" in navigator && "PushManager" in window);
  const [needsIOSInstall] = useState(() => isIOS() && !isStandalone());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || needsIOSInstall) return;
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setSubscribed(Boolean(sub));
      })
      .catch(() => {
        /* ignore — subscribed stays false, same as "never subscribed" */
      });
    return () => {
      cancelled = true;
    };
  }, [supported, needsIOSInstall]);

  async function subscribe() {
    setError(null);
    if (needsIOSInstall) {
      // PushToggle.tsx shouldn't even show a button in this case, but guard here too in case
      // subscribe() is ever called another way — a plain Safari tab's subscribe() call would
      // otherwise fail with an opaque browser error instead of this actionable one.
      setError("Add Borla to your Home Screen first (Share → Add to Home Screen), then open it from there to turn on notifications.");
      return;
    }
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Notifications permission wasn't granted.");
        return;
      }
      const { publicKey } = await api<{ publicKey: string | null }>("/push/vapid-public-key", { auth: false });
      if (!publicKey) {
        setError("Push notifications aren't turned on for this server yet.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // TS's DOM lib types applicationServerKey against BufferSource/ArrayBuffer specifically,
        // while Uint8Array's own type is generic over ArrayBufferLike (which also covers
        // SharedArrayBuffer) — a known lib.dom.d.ts strictness mismatch, not a real runtime
        // concern here (this Uint8Array is always backed by a plain ArrayBuffer).
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
      setSubscribed(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (isSafari()) {
        // Desktop Safari has its own, less predictable version of iOS's install requirement
        // (historically: added to the Dock, not just any open tab) — not confirmed reliably
        // enough to hard-block the button the way needsIOSInstall does for iOS, but a real
        // subscribe() failure on Safari is very plausibly exactly that, so say so.
        setError("Could not enable notifications. On Safari, try adding this page to your Dock (or Home Screen) first, then try again.");
      } else {
        setError("Could not enable notifications");
      }
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Best-effort: even if telling the server fails, unsubscribing the browser-side
        // subscription below is what actually stops notifications from arriving on this device —
        // that must never be blocked by a flaky network call.
        await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => null);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not turn off notifications");
    } finally {
      setBusy(false);
    }
  }

  return { supported, needsIOSInstall, subscribed, busy, error, subscribe, unsubscribe };
}
