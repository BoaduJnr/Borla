import { redis } from "./client.js";
import { withTimeout } from "../utils/withTimeout.js";
import { checkInMemoryRateLimit } from "../utils/inMemoryRateLimit.js";

/**
 * Redis-backed rate limiting (borla-technical-design.md §4.2/§7), resolving
 * Technical_Debt_Plan.md TD-05's rate-limiter half. `INCR` + `EXPIRE` on first increment is the
 * standard fixed-window counter pattern — cheap, and correct enough at this scale (a sliding
 * window would be more precise but isn't worth the extra Redis round-trips here).
 */

/**
 * OTP requests: at most `limit` per phone number within `windowSeconds`. Explicitly
 * time-boxed, not just wrapped in try/catch: found live that ioredis's own
 * `maxRetriesPerRequest` doesn't fail nearly as fast as its name suggests once a connection is
 * genuinely unreachable (retry/backoff cycles stacked up to tens of seconds during tonight's
 * Upstash incident) — a bare .catch() only helps once the promise actually settles, and login
 * itself must never be held hostage to how long that takes.
 */
export async function checkOtpRateLimit(phone: string, limit = 5, windowSeconds = 600): Promise<boolean> {
  const key = `ratelimit:otp:${phone}`;
  try {
    const count = await withTimeout(redis.incr(key), 2000, "redis.incr(otp)");
    if (count === 1) await withTimeout(redis.expire(key, windowSeconds), 2000, "redis.expire(otp)");
    return count <= limit;
  } catch (err) {
    // Degrade to a process-local counter rather than failing wide open: a rate limiter's job is
    // to protect against abuse, and "some cap, scoped to this instance, for as long as Redis is
    // down" beats "zero cap at all" for exactly as long as this incident lasts. Still never lets
    // a Redis outage become a second point of failure that locks every real user out of signing
    // in — this only gets stricter than a hard-down state, never less available.
    console.error(`[rateLimit] Redis unavailable for OTP rate limit (${phone}) — falling back to in-memory`, err);
    return checkInMemoryRateLimit(`otp:${phone}`, limit, windowSeconds);
  }
}

/**
 * Notification fan-out cap (design §7): protects a collector from alert fatigue in dense areas.
 * `ratelimit:notif:{collectorId}` — at most `limit` broadcast notifications per collector within
 * `windowSeconds`. Returns true if this notification is allowed to send.
 */
export async function checkNotifRateLimit(collectorId: string, limit: number, windowSeconds = 600): Promise<boolean> {
  const key = `ratelimit:notif:${collectorId}`;
  try {
    const count = await withTimeout(redis.incr(key), 2000, "redis.incr(notif)");
    if (count === 1) await withTimeout(redis.expire(key, windowSeconds), 2000, "redis.expire(notif)");
    return count <= limit;
  } catch (err) {
    // Same in-memory-degrade reasoning as checkOtpRateLimit above — this only runs inside the
    // async fanout job anyway (never blocks a household's own request), so falling back here
    // just means the notification cap is enforced per-process instead of via Redis, not that
    // anything breaks.
    console.error(`[rateLimit] Redis unavailable for notif rate limit (${collectorId}) — falling back to in-memory`, err);
    return checkInMemoryRateLimit(`notif:${collectorId}`, limit, windowSeconds);
  }
}
