import webpush from "web-push";
import { query } from "../db/pool.js";
import { config } from "../config.js";
import { withTimeout } from "../utils/withTimeout.js";

/**
 * Web Push (Push API + VAPID) — real OS-level notifications, closing the gap Socket.IO's
 * emitToUser() alone can't: that only reaches a client with the tab open and connected right
 * now. This is the actual gap identified for Borla's core loop (a collector who's closed the tab
 * gets nothing when a new pin appears nearby) — see notify.ts for which events actually push.
 *
 * Configured lazily, once, from config.vapid — same fail-open-without-a-key pattern already used
 * for Gemini moderation (ai/moderation.ts) and GiantSMS: no key configured means every send is a
 * silent no-op, never a hard failure that could block the socket half of a notification.
 */
let configured = false;
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  configured = true;
  return true;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Lets the OS/browser collapse repeated notifications about the same thing (e.g. re-sends of
   *  the same broadcast) into one, instead of stacking up a tray full of near-duplicates. */
  tag?: string;
}

/**
 * Sends to every device/browser this user has ever subscribed from (Promise.allSettled — one
 * dead subscription must never stop the others from receiving it). Best-effort by design: never
 * throws, so a push failure can never take down the socket emit or the route handler it's called
 * from. A 404/410 from the push service means that subscription is permanently gone (uninstalled,
 * permission revoked, browser data cleared) — cleaned up here so future sends stop retrying a
 * dead endpoint; any other error (timeout, transient network blip) is logged and left alone,
 * since it isn't that subscription's fault and may well succeed next time.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;

  const subs = await query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId]
  );
  if (subs.length === 0) return;

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await withTimeout(
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            {
              // "normal" (the default) is exactly what FCM/Android's battery-optimization Doze
              // mode deprioritizes and can visibly delay — every notification Borla actually
              // sends is a real 1:1 signal, not bulk/marketing traffic, so there's no downside
              // to asking for prompt delivery every time.
              urgency: "high",
              // Bounded so a notification about something time-sensitive (a pin that's since
              // expired, a request that's since timed out) doesn't sit queued and then arrive
              // hours later the next time an offline phone reconnects. 1 hour comfortably covers
              // every current event's own natural lifetime (broadcast pins expire in well under
              // that — app_config's pin_ttl_minutes default is 45).
              TTL: 3600,
            }
          ),
          5000,
          "webpush.sendNotification"
        );
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]).catch(() => null);
        } else {
          console.error(`[push] send failed for subscription ${sub.id}`, err?.message ?? err);
        }
      }
    })
  );
}
