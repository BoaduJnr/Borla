import { redis } from "./client.js";
import { query } from "../db/pool.js";
import { withTimeout } from "../utils/withTimeout.js";

/**
 * Presence & the live geo substrate (borla-technical-design.md §4.2/§5/§6), resolving
 * Technical_Debt_Plan.md TD-05. Redis keys, matching the original design exactly:
 *   presence:{collectorId}   string "1", TTL ~45s        — is-online flag
 *   geo:collectors           GEO set                     — live positions of ONLINE collectors
 *   heartbeat:zset           ZSET, score = last-seen ms   — drives the presence sweep
 *   pins:active              GEO set                     — active broadcast pin locations
 *
 * Postgres/PostGIS stays the durable source of truth (collectors.online/last_location mirrored
 * for admin reads/history) — Redis is purely the hot-path GEOSEARCH substrate. A collector or
 * pin is only ever "matchable" if it's actually present in these Redis sets; the durable copy
 * is a best-effort mirror, never consulted for live matching.
 */

const PRESENCE_TTL_SECONDS = 45;
const GEO_COLLECTORS = "geo:collectors";
const HEARTBEAT_ZSET = "heartbeat:zset";
const PINS_ACTIVE = "pins:active";

export async function goOnline(collectorId: string, lon: number, lat: number) {
  await Promise.all([
    redis.set(`presence:${collectorId}`, "1", "EX", PRESENCE_TTL_SECONDS),
    redis.geoadd(GEO_COLLECTORS, lon, lat, collectorId),
    redis.zadd(HEARTBEAT_ZSET, Date.now(), collectorId),
  ]);
}

export const heartbeat = goOnline; // identical effect: refresh TTL + position + last-seen score

export async function goOffline(collectorId: string) {
  await Promise.all([
    redis.del(`presence:${collectorId}`),
    redis.zrem(HEARTBEAT_ZSET, collectorId),
    redis.zrem(GEO_COLLECTORS, collectorId),
  ]);
}

export async function isOnline(collectorId: string): Promise<boolean> {
  return (await redis.exists(`presence:${collectorId}`)) === 1;
}

export interface GeoHit {
  id: string;
  lon: number;
  lat: number;
  distanceM: number;
}

/** Q1 (design §5): "which online collectors are near this point?" */
export async function nearbyCollectors(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  return geosearch(GEO_COLLECTORS, lon, lat, radiusM);
}

/** Q2 (design §5): "which active pins are near this moving collector?" */
export async function nearbyPinIds(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  return geosearch(PINS_ACTIVE, lon, lat, radiusM);
}

async function geosearch(key: string, lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  // ioredis's geosearch typings vary by version; the raw command form is stable across all of them.
  const raw = (await (redis as any).call(
    "GEOSEARCH",
    key,
    "FROMLONLAT",
    lon,
    lat,
    "BYRADIUS",
    radiusM,
    "m",
    "ASC",
    "WITHCOORD",
    "WITHDIST"
  )) as [string, string, [string, string]][];
  return raw.map(([id, dist, coord]) => ({
    id,
    distanceM: Number(dist),
    lon: Number(coord[0]),
    lat: Number(coord[1]),
  }));
}

/**
 * Postgres-backed stand-ins for the two GEOSEARCH queries above, and "merged" wrappers that
 * consult BOTH sources rather than only falling back to Postgres when Redis explicitly errors.
 *
 * Found live (via GET /admin/live-map showing a collector correctly online with a fresh
 * position, while GET /collectors/nearby against the exact same point returned nothing): under
 * the ongoing Upstash quota pressure, a GEOADD write can be silently dropped without the
 * *write* call ever throwing (or throwing in a way already caught non-fatally, per the presence/
 * broadcasts route resilience work) — leaving `geo:collectors`/`pins:active` simply short a
 * member. A subsequent GEOSEARCH on that same key then correctly, cleanly returns "nothing
 * here" — it isn't lying, Redis genuinely doesn't have the entry — so error-only fallback logic
 * (this file's earlier callers, and jobs/workers.ts's fan-out candidate matching, all used this
 * pattern) never triggers: there's no error to catch, just a silently-incomplete answer.
 * Postgres (`collectors.online`/`last_location`, `broadcasts.location`) is written
 * unconditionally on every presence/broadcast change regardless of Redis's outcome, so it's
 * always at least as complete as Redis, and is queried unconditionally here too — the union of
 * both, deduped by id, is only ever as small as the more complete source, whichever that is on a
 * given call.
 */
async function nearbyCollectorsPg(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  const rows = await query<{ id: string; lon: number; lat: number; distance_m: string }>(
    `SELECT c.user_id AS id, c.last_lon AS lon, c.last_lat AS lat,
            ST_Distance(c.last_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
     FROM collectors c
     WHERE c.online = true AND c.last_location IS NOT NULL
       AND ST_DWithin(c.last_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY distance_m ASC`,
    [lon, lat, radiusM]
  );
  return rows.map((r) => ({ id: r.id, lon: r.lon, lat: r.lat, distanceM: Number(r.distance_m) }));
}

async function nearbyPinsPg(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  const rows = await query<{ id: string; lon: number; lat: number; distance_m: string }>(
    `SELECT b.id, b.lon, b.lat,
            ST_Distance(b.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
     FROM broadcasts b
     WHERE b.status = 'active'
       AND ST_DWithin(b.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
     ORDER BY distance_m ASC`,
    [lon, lat, radiusM]
  );
  return rows.map((r) => ({ id: r.id, lon: r.lon, lat: r.lat, distanceM: Number(r.distance_m) }));
}

function mergeHits(redisHits: GeoHit[], pgHits: GeoHit[]): GeoHit[] {
  const byId = new Map<string, GeoHit>();
  for (const h of pgHits) byId.set(h.id, h);
  for (const h of redisHits) byId.set(h.id, h); // Redis wins on overlap (identical data either way)
  return [...byId.values()].sort((a, b) => a.distanceM - b.distanceM);
}

export async function nearbyCollectorsMerged(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  const [redisResult, pgResult] = await Promise.allSettled([
    withTimeout(nearbyCollectors(lon, lat, radiusM), 3000, "presence.nearbyCollectors"),
    nearbyCollectorsPg(lon, lat, radiusM),
  ]);
  if (redisResult.status === "rejected") console.error("[presence] Redis nearbyCollectors failed, using Postgres only", redisResult.reason);
  return mergeHits(
    redisResult.status === "fulfilled" ? redisResult.value : [],
    pgResult.status === "fulfilled" ? pgResult.value : []
  );
}

export async function nearbyPinsMerged(lon: number, lat: number, radiusM: number): Promise<GeoHit[]> {
  const [redisResult, pgResult] = await Promise.allSettled([
    withTimeout(nearbyPinIds(lon, lat, radiusM), 3000, "presence.nearbyPinIds"),
    nearbyPinsPg(lon, lat, radiusM),
  ]);
  if (redisResult.status === "rejected") console.error("[presence] Redis nearbyPinIds failed, using Postgres only", redisResult.reason);
  return mergeHits(
    redisResult.status === "fulfilled" ? redisResult.value : [],
    pgResult.status === "fulfilled" ? pgResult.value : []
  );
}

export async function pinActive(broadcastId: string, lon: number, lat: number) {
  await redis.geoadd(PINS_ACTIVE, lon, lat, broadcastId);
}

export async function pinCleared(broadcastId: string) {
  await redis.zrem(PINS_ACTIVE, broadcastId);
}

/**
 * Presence sweep (design §6): self-healing honesty backstop. GEO sets have no native per-member
 * TTL, so `heartbeat:zset`'s score is what tells us who's actually gone stale — evict from both
 * the geo set and the presence flag, and report who got evicted so the caller can mirror it to
 * Postgres (`collectors.online = false`).
 */
export async function sweepStalePresence(maxAgeSeconds = PRESENCE_TTL_SECONDS): Promise<string[]> {
  const staleIds = await redis.zrangebyscore(HEARTBEAT_ZSET, 0, Date.now() - maxAgeSeconds * 1000);
  if (staleIds.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of staleIds) {
    pipeline.del(`presence:${id}`);
    pipeline.zrem(HEARTBEAT_ZSET, id);
    pipeline.zrem(GEO_COLLECTORS, id);
  }
  await pipeline.exec();
  return staleIds;
}

export async function onlineCollectorCount(): Promise<number> {
  return redis.zcard(GEO_COLLECTORS);
}
