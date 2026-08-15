/**
 * A tiny in-process fixed-window counter — the fallback rate limiters in redis/rateLimit.ts
 * reach for when Redis itself is unavailable. Deliberately not a general-purpose replacement
 * for the Redis-backed limiter (it doesn't survive a restart and doesn't coordinate across
 * multiple instances — Redis being the real, correct implementation for both), but "some
 * abuse protection, scoped to this one process, for as long as the outage lasts" is strictly
 * better than the alternative of failing fully open with zero cap at all. The app is a single
 * Render instance today, so a process-local counter is exactly as effective as Redis's would be
 * for the current deployment shape.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Lazily sweep expired entries on access rather than running a timer — this module may go
// entirely unused for the app's whole lifetime if Redis never has a bad day.
function sweepIfStale(key: string, now: number) {
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt <= now) buckets.delete(key);
}

/** Returns true if this call is allowed under the cap, incrementing the in-memory counter either way. */
export function checkInMemoryRateLimit(key: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  sweepIfStale(key, now);
  const bucket = buckets.get(key);
  if (!bucket) {
    buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}
