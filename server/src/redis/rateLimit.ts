import { redis } from "./client.js";

/**
 * Redis-backed rate limiting (borla-technical-design.md §4.2/§7), resolving
 * Technical_Debt_Plan.md TD-05's rate-limiter half. `INCR` + `EXPIRE` on first increment is the
 * standard fixed-window counter pattern — cheap, and correct enough at this scale (a sliding
 * window would be more precise but isn't worth the extra Redis round-trips here).
 */

/** OTP requests: at most `limit` per phone number within `windowSeconds`. */
export async function checkOtpRateLimit(phone: string, limit = 5, windowSeconds = 600): Promise<boolean> {
  const key = `ratelimit:otp:${phone}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}

/**
 * Notification fan-out cap (design §7): protects a collector from alert fatigue in dense areas.
 * `ratelimit:notif:{collectorId}` — at most `limit` broadcast notifications per collector within
 * `windowSeconds`. Returns true if this notification is allowed to send.
 */
export async function checkNotifRateLimit(collectorId: string, limit: number, windowSeconds = 600): Promise<boolean> {
  const key = `ratelimit:notif:${collectorId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return count <= limit;
}
