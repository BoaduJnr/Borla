import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Redis is the hot-path matching substrate (borla-technical-design.md §4.2): live presence,
 * the geo:collectors GEO set, and notification rate limiting. Postgres/PostGIS remains the
 * durable source of truth for everything else — this resolves Technical_Debt_Plan.md TD-05.
 *
 * Two separate ioredis instances are kept deliberately:
 *  - `redis`      — plain commands (GEOADD, INCR, SET EX, ...) from route handlers.
 *  - `bullRedis`  — handed to every BullMQ Queue/Worker. BullMQ requires
 *    `maxRetriesPerRequest: null` on its connection (it manages its own retry/backoff for
 *    blocking commands) — sharing that setting with the plain client would make ordinary
 *    commands retry forever on a transient outage instead of failing fast.
 */

const commonOptions = {
  lazyConnect: false,
};

export const redis = new Redis(config.redisUrl, { ...commonOptions, maxRetriesPerRequest: 3 });
export const bullRedis = new Redis(config.redisUrl, { ...commonOptions, maxRetriesPerRequest: null });

redis.on("error", (err: Error) => console.error("[redis] connection error", err.message));
bullRedis.on("error", (err: Error) => console.error("[redis:bullmq] connection error", err.message));

export async function closeRedis() {
  await Promise.allSettled([redis.quit(), bullRedis.quit()]);
}
