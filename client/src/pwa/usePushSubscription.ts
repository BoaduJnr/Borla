import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { urlBase64ToUint8Array } from "../utils/push";

/**
 * Real OS-level push notifications (closes the gap Socket.IO's emitToUser() alone can't — that
 * only reaches a tab that's open and connected right now). Explicit opt-in only: asks for
 * `Notification.requestPermission()` — a real browser permission prompt — only from a direct tap
 * on "Enable notifications" (see PushToggle.tsx), never automatically on load. Same "a stranger/
 * user deserves an informed prompt, not a surprise browser popup" philosophy already used for
 * geolocation (useGeolocation.ts) and RouteMeReceive's own "Locate me" button.
 */
export function usePushSubscription() {
  const [supported] = useState(() => "serviceWorker" in navigator && "PushManager" in window);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
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
  }, [supported]);

  async function subscribe() {
    setError(null);
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
      setError(err instanceof ApiError ? err.message : "Could not enable notifications");
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

  return { supported, subscribed, busy, error, subscribe, unsubscribe };
}
