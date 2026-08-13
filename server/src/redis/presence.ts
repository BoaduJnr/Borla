import { redis } from "./client.js";

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
