import { emitToUser } from "./realtime/socket.js";
import { sendPushToUser, type PushPayload } from "./push/webpush.js";

/**
 * Fires both channels a user might currently be reachable on: the always-on Socket.IO event
 * (delivered only while a tab is open and connected) and, when `push` is given, a real OS-level
 * push notification via Web Push (delivered even with the tab closed or the phone locked — the
 * actual gap this exists to close). Every former direct `emitToUser` call site in the app now
 * goes through here instead, so socket and push never drift apart for the same event.
 *
 * `push` is deliberately omitted at call sites that are just confirming the *current* user's own
 * just-performed action back to them — a collector's own "arrived" tap, or a household's own
 * broadcast fan-out count. They're already looking at the result on screen; an OS notification
 * for it would be pure noise, not a "full parity" gap. Every other event a user didn't just
 * cause themselves gets one.
 */
export function notifyUser(userId: string, event: string, payload: unknown, push?: PushPayload) {
  emitToUser(userId, event, payload);
  if (push) {
    sendPushToUser(userId, push).catch((err) => console.error(`[notify] push failed for ${event}`, err));
  }
}
