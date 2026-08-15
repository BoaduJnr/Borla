/**
 * Races a promise against a hard deadline. Needed specifically for Redis/BullMQ calls in the
 * request path: BullMQ's own connection (`bullRedis`, redis/client.ts) is configured with
 * `maxRetriesPerRequest: null` — a real BullMQ requirement, not a bug — which means a `.add()`
 * call against an unreachable Redis just retries forever instead of ever rejecting. Found live:
 * wrapping such a call in `.catch()` alone does nothing if the promise never settles in the
 * first place — the HTTP request hangs until the client times out, not until the `.catch()`
 * fires. Every "best-effort" Redis/BullMQ call outside the plain `redis` client (which at least
 * has a bounded `maxRetriesPerRequest: 3`) should race through this rather than being awaited
 * directly.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
