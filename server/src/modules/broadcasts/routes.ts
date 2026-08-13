import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { emitToUser } from "../../realtime/socket.js";
import { getConfigNumber, AppConfigKeys, defaults } from "../../utils/appConfig.js";
import { inQuietHours } from "../../utils/quietHours.js";

export const broadcastsRouter = Router();

const createSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  wasteType: z.enum(["general", "recyclable", "organic", "bulky"]).optional(),
  note: z.string().max(280).optional(),
});

/**
 * POST /broadcasts — the digital bell (design §3.1). No collector binding, no accept, no lock —
 * the row exists only to fan out one notification and show a pin until it's gone.
 */
broadcastsRouter.post(
  "/broadcasts",
  requireAuth,
  requireRole("household"),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { lon, lat, wasteType, note } = req.body as z.infer<typeof createSchema>;
    const household = req.user!;

    const existingActive = await queryOne(
      `SELECT id FROM broadcasts WHERE household_id = $1 AND status = 'active'`,
      [household.id]
    );
    if (existingActive) {
      throw new ApiError(409, "You already have an active pin — clear it before creating a new one");
    }

    const ttlMinutes = await getConfigNumber(AppConfigKeys.pinTtlMinutes, defaults.pinTtlMinutes);
    const radiusM = await getConfigNumber(AppConfigKeys.broadcastRadiusM, defaults.broadcastRadiusM);

    const broadcast = await queryOne<{ id: string; expires_at: string }>(
      `INSERT INTO broadcasts (household_id, lon, lat, location, waste_type, note, expires_at)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4, $5,
               now() + interval '${ttlMinutes} minutes')
       RETURNING id, expires_at`,
      [household.id, lon, lat, wasteType ?? null, note ?? null]
    );

    // --- Fan-out gauntlet (design §7): online -> in-range -> waste-type match -> quiet hours ---
    const candidates = await query<{
      user_id: string;
      waste_types: string[];
      quiet_hours: { start: string; end: string } | null;
    }>(
      `SELECT c.user_id, c.waste_types, c.quiet_hours
       FROM collectors c
       JOIN users u ON u.id = c.user_id
       WHERE c.online = true AND u.suspended = false
         AND ST_DWithin(c.last_location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`,
      [lon, lat, radiusM]
    );

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const notified: string[] = [];
    for (const c of candidates) {
      if (wasteType && c.waste_types?.length && !c.waste_types.includes(wasteType)) continue;
      if (c.quiet_hours && inQuietHours(nowMinutes, c.quiet_hours)) continue;
      notified.push(c.user_id);
    }

    for (const collectorId of notified) {
      await query(
        `INSERT INTO broadcast_notifications (broadcast_id, collector_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [broadcast!.id, collectorId]
      );
      emitToUser(collectorId, "broadcast:new", {
        broadcastId: broadcast!.id,
        lon,
        lat,
        wasteType: wasteType ?? null,
        note: note ?? null,
        householdName: household.display_name,
        householdPhone: household.phone, // reveal is immediate for broadcasts — see design §10 / SRS NFR-Privacy
      });
    }

    res.status(201).json({ broadcast: { ...broadcast, status: "active" }, notifiedCollectors: notified.length });
  })
);

/** POST /broadcasts/:id/clear — household clears their own pin the moment someone shows. */
broadcastsRouter.post(
  "/broadcasts/:id/clear",
  requireAuth,
  requireRole("household"),
  asyncHandler(async (req, res) => {
    const row = await queryOne<{ id: string }>(
      `UPDATE broadcasts SET status = 'cleared', resolved_at = now()
       WHERE id = $1 AND household_id = $2 AND status = 'active'
       RETURNING id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new ApiError(404, "No active broadcast found to clear");

    const notifiedCollectors = await query<{ collector_id: string }>(
      `SELECT collector_id FROM broadcast_notifications WHERE broadcast_id = $1`,
      [row.id]
    );
    for (const { collector_id } of notifiedCollectors) {
      emitToUser(collector_id, "broadcast:cleared", { broadcastId: row.id });
    }
    res.json({ ok: true });
  })
);

/** GET /broadcasts/me/active — household's current pin, if any (drives the sticky clear-banner). */
broadcastsRouter.get(
  "/broadcasts/me/active",
  requireAuth,
  requireRole("household"),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `SELECT id, lon, lat, waste_type, note, status, created_at, expires_at
       FROM broadcasts WHERE household_id = $1 AND status = 'active'`,
      [req.user!.id]
    );
    res.json({ broadcast: row });
  })
);

const nearbySchema = z.object({
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  radius: z.coerce.number().min(50).max(20000).default(1500),
});

/** GET /pins/nearby — collector's live map of nearby waste (design §5, Q2). */
broadcastsRouter.get(
  "/pins/nearby",
  requireAuth,
  requireRole("collector"),
  validateQuery(nearbySchema),
  asyncHandler(async (req, res) => {
    const { lon, lat, radius } = req.query as unknown as { lon: number; lat: number; radius: number };
    const rows = await query(
      `SELECT b.id, b.lon, b.lat, b.waste_type, b.note, b.created_at, b.expires_at,
              u.display_name AS household_name, u.phone AS household_phone,
              ST_Distance(b.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       FROM broadcasts b
       JOIN users u ON u.id = b.household_id
       WHERE b.status = 'active'
         AND ST_DWithin(b.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY distance_m ASC
       LIMIT 100`,
      [lon, lat, radius]
    );
    res.json({ pins: rows });
  })
);

/**
 * POST /confirmations — "Did they come?" (design §16). Identifies which collector served a
 * no-winner broadcast, which is what makes a broadcast-side review possible at all.
 */
const confirmSchema = z.object({
  broadcastId: z.string().uuid(),
  came: z.boolean(),
  collectorId: z.string().uuid().optional(), // required when came = true
});

broadcastsRouter.post(
  "/confirmations",
  requireAuth,
  requireRole("household"),
  validateBody(confirmSchema),
  asyncHandler(async (req, res) => {
    const { broadcastId, came, collectorId } = req.body as z.infer<typeof confirmSchema>;
    const broadcast = await queryOne<{ id: string }>(
      `SELECT id FROM broadcasts WHERE id = $1 AND household_id = $2`,
      [broadcastId, req.user!.id]
    );
    if (!broadcast) throw new ApiError(404, "Broadcast not found");

    if (came) {
      if (!collectorId) throw new ApiError(400, "collectorId is required when came = true");
      const wasNotified = await queryOne(
        `SELECT 1 FROM broadcast_notifications WHERE broadcast_id = $1 AND collector_id = $2`,
        [broadcastId, collectorId]
      );
      if (!wasNotified) throw new ApiError(400, "That collector was not notified about this pin");
    }

    const row = await queryOne(
      `INSERT INTO pickup_confirmations (broadcast_id, household_id, collector_id, came)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (broadcast_id, household_id) DO UPDATE SET came = EXCLUDED.came, collector_id = EXCLUDED.collector_id
       RETURNING id`,
      [broadcastId, req.user!.id, came ? collectorId : null, came]
    );
    res.status(201).json({ confirmation: row });
  })
);

/** GET /broadcasts/:id/notified — who was notified, for the "Did they come?" collector picker. */
broadcastsRouter.get(
  "/broadcasts/:id/notified",
  requireAuth,
  requireRole("household"),
  asyncHandler(async (req, res) => {
    const owns = await queryOne(`SELECT id FROM broadcasts WHERE id = $1 AND household_id = $2`, [
      req.params.id,
      req.user!.id,
    ]);
    if (!owns) throw new ApiError(404, "Broadcast not found");
    const rows = await query(
      `SELECT u.id, u.display_name FROM broadcast_notifications bn
       JOIN users u ON u.id = bn.collector_id
       WHERE bn.broadcast_id = $1`,
      [req.params.id]
    );
    res.json({ collectors: rows });
  })
);
