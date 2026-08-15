import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import * as presence from "../../redis/presence.js";
import { withTimeout } from "../../utils/withTimeout.js";

export const presenceRouter = Router();

const toggleSchema = z.object({
  online: z.boolean(),
  lon: z.number().min(-180).max(180).optional(),
  lat: z.number().min(-90).max(90).optional(),
});

/**
 * POST /presence — collector "Go online / Go offline" toggle (borla-technical-design.md §6).
 * Gated on `users.verified` so only KYC-lite-approved collectors ever enter the matchable set.
 * Redis (`presence:{id}`, `geo:collectors`, `heartbeat:zset`) is the live matching substrate
 * (Technical_Debt_Plan.md TD-05); Postgres is updated alongside purely as a durable mirror for
 * admin reads/history — it is never consulted for live matching.
 */
presenceRouter.post(
  "/presence",
  requireAuth,
  requireRole("collector"),
  validateBody(toggleSchema),
  asyncHandler(async (req, res) => {
    const { online, lon, lat } = req.body as { online: boolean; lon?: number; lat?: number };
    const user = req.user!;

    if (online) {
      if (!user.verified) {
        throw new ApiError(403, "Your collector account is not verified yet — an admin must approve you before you can go online");
      }
      if (lon === undefined || lat === undefined) {
        throw new ApiError(400, "lon/lat required to go online");
      }
      // Redis is best-effort here, not load-bearing: a Redis incident (found live — an exhausted
      // Upstash free-tier quota) must never stop a collector from actually going online in the
      // one place that matters for real, Postgres — GET /collectors/nearby's own fallback below
      // reads straight from collectors.online/last_location when Redis's geosearch is down, so
      // this write is what keeps matching alive during an outage, not just a mirror of it.
      await withTimeout(presence.goOnline(user.id, lon, lat), 3000, "presence.goOnline").catch((err) => {
        console.error(`[presence] Redis goOnline failed for ${user.id} — continuing Postgres-only`, err);
      });
      await query(
        `UPDATE collectors SET
           online = true,
           last_lon = $1, last_lat = $2,
           last_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           last_seen_at = now()
         WHERE user_id = $3`,
        [lon, lat, user.id]
      );
    } else {
      await withTimeout(presence.goOffline(user.id), 3000, "presence.goOffline").catch((err) => {
        console.error(`[presence] Redis goOffline failed for ${user.id} — continuing Postgres-only`, err);
      });
      await query(`UPDATE collectors SET online = false WHERE user_id = $1`, [user.id]);
    }

    res.json({ online });
  })
);

const heartbeatSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/**
 * POST /presence/heartbeat — sustains "online" (design §6). Refreshes the Redis TTL/geo/last-
 * seen score; the BullMQ presence-sweep job evicts anyone whose heartbeat goes stale, which is
 * the self-healing honesty guarantee described in the original design.
 */
presenceRouter.post(
  "/presence/heartbeat",
  requireAuth,
  requireRole("collector"),
  validateBody(heartbeatSchema),
  asyncHandler(async (req, res) => {
    const { lon, lat } = req.body as { lon: number; lat: number };
    // Falls back to Postgres's own online flag if Redis can't answer — the same reasoning as
    // POST /presence below: a Redis incident must degrade this check, never turn it into a hard
    // failure that locks a genuinely-online collector out of sending further heartbeats.
    const isOnline = await withTimeout(presence.isOnline(req.user!.id), 3000, "presence.isOnline").catch(async (err) => {
      console.error(`[presence] Redis isOnline check failed for ${req.user!.id} — falling back to Postgres`, err);
      const row = await queryOne<{ online: boolean }>(`SELECT online FROM collectors WHERE user_id = $1`, [req.user!.id]);
      return row?.online ?? false;
    });
    if (!isOnline) {
      throw new ApiError(400, "Not online — call POST /presence first");
    }

    await withTimeout(presence.heartbeat(req.user!.id, lon, lat), 3000, "presence.heartbeat").catch((err) => {
      console.error(`[presence] Redis heartbeat failed for ${req.user!.id} — continuing Postgres-only`, err);
    });
    await query(
      `UPDATE collectors SET
         last_lon = $1, last_lat = $2,
         last_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         last_seen_at = now()
       WHERE user_id = $3`,
      [lon, lat, req.user!.id]
    );
    res.json({ ok: true });
  })
);

const nearbySchema = z.object({
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  radius: z.coerce.number().min(50).max(20000).default(1200),
});

/** GET /collectors/nearby — "which online collectors are near this point" (design §5, Q1). */
presenceRouter.get(
  "/collectors/nearby",
  requireAuth,
  validateQuery(nearbySchema),
  asyncHandler(async (req, res) => {
    const { lon, lat, radius } = req.query as unknown as { lon: number; lat: number; radius: number };
    // Merges Redis's GEOSEARCH with a Postgres geo query rather than only falling back on an
    // explicit error — a silently-incomplete Redis write (found live) means GEOSEARCH can
    // cleanly return "nothing here" without ever erroring, which error-only fallback logic
    // can't detect. See redis/presence.ts's nearbyCollectorsMerged for the full story.
    const hits = await presence.nearbyCollectorsMerged(lon, lat, radius);
    if (hits.length === 0) return res.json({ collectors: [] });

    const rows = await query<{
      id: string;
      display_name: string | null;
      vehicle_type: string | null;
      waste_types: string[];
      rating_avg: string | null;
      rating_count: number;
    }>(
      `SELECT u.id, u.display_name, c.vehicle_type, c.waste_types, c.rating_avg, c.rating_count
       FROM collectors c JOIN users u ON u.id = c.user_id
       WHERE u.suspended = false AND c.user_id = ANY($1)`,
      [hits.map((h) => h.id)]
    );
    const profileById = new Map(rows.map((r) => [r.id, r]));

    const collectors = hits
      .map((h) => {
        const profile = profileById.get(h.id);
        if (!profile) return null; // suspended, or a stale Redis entry the sweep hasn't caught yet
        return { ...profile, last_lon: h.lon, last_lat: h.lat, distance_m: h.distanceM };
      })
      .filter(Boolean);
    res.json({ collectors });
  })
);

const householdMeSchema = z.object({
  homeLon: z.number().min(-180).max(180).optional(),
  homeLat: z.number().min(-90).max(90).optional(),
  alertRadiusM: z.number().min(100).max(5000).optional(),
  alertsEnabled: z.boolean().optional(),
});

presenceRouter.patch(
  "/households/me",
  requireAuth,
  requireRole("household"),
  validateBody(householdMeSchema),
  asyncHandler(async (req, res) => {
    const { homeLon, homeLat, alertRadiusM, alertsEnabled } = req.body as z.infer<typeof householdMeSchema>;
    const setLocation = homeLon !== undefined && homeLat !== undefined;
    const row = await queryOne(
      `UPDATE households SET
         home_lon = COALESCE($1, home_lon),
         home_lat = COALESCE($2, home_lat),
         home_location = CASE WHEN $5 THEN ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography ELSE home_location END,
         alert_radius_m = COALESCE($3, alert_radius_m),
         alerts_enabled = COALESCE($4, alerts_enabled)
       WHERE user_id = $6
       RETURNING home_lon, home_lat, alert_radius_m, alerts_enabled`,
      [homeLon ?? null, homeLat ?? null, alertRadiusM ?? null, alertsEnabled ?? null, setLocation, req.user!.id]
    );
    res.json({ household: row });
  })
);

const collectorMeSchema = z.object({
  vehicleType: z.string().max(40).optional(),
  wasteTypes: z.array(z.enum(["general", "recyclable", "organic", "bulky"])).optional(),
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
});

presenceRouter.patch(
  "/collectors/me",
  requireAuth,
  requireRole("collector"),
  validateBody(collectorMeSchema),
  asyncHandler(async (req, res) => {
    const { vehicleType, wasteTypes, quietHours } = req.body as z.infer<typeof collectorMeSchema>;
    const row = await queryOne(
      `UPDATE collectors SET
         vehicle_type = COALESCE($1, vehicle_type),
         waste_types = COALESCE($2, waste_types),
         quiet_hours = CASE WHEN $3::text IS NOT NULL THEN $3::jsonb ELSE quiet_hours END
       WHERE user_id = $4
       RETURNING vehicle_type, waste_types, quiet_hours`,
      [vehicleType ?? null, wasteTypes ?? null, quietHours === undefined ? null : JSON.stringify(quietHours), req.user!.id]
    );
    res.json({ collector: row });
  })
);
