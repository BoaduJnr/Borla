import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { emitToUser } from "../../realtime/socket.js";
import { getConfigNumber, AppConfigKeys, defaults } from "../../utils/appConfig.js";
import * as presence from "../../redis/presence.js";
import { fanoutQueue } from "../../jobs/queues.js";
import { runFanoutLogic } from "../../jobs/index.js";
import { withTimeout } from "../../utils/withTimeout.js";

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
 *
 * The pin is registered in Redis (`pins:active`) synchronously so a collector's very next
 * `/pins/nearby` poll sees it immediately; the actual candidate-matching + notification gauntlet
 * (design §7) runs in a BullMQ `fanout` job (Technical_Debt_Plan.md TD-05) so a broadcast with
 * many nearby collectors never blocks this response, and a transient failure retries with
 * backoff instead of silently dropping notifications.
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

    // Both Redis-dependent steps below are best-effort against the pin the household just got
    // back a 201 for — a Redis incident (found live — an exhausted Upstash free-tier quota) must
    // never turn "your pin is up" into a 500 when the pin itself (Postgres, above) is already
    // safely created. Losing pinActive means GET /pins/nearby falls back to the Postgres query
    // below instead of Redis's hot geosearch; losing the fanout enqueue means this specific
    // broadcast doesn't get its async notification pass — a real degrade, but "the pin exists
    // and collectors can still find it by polling" beats "the household can't broadcast at all."
    await withTimeout(presence.pinActive(broadcast!.id, lon, lat), 3000, "presence.pinActive").catch((err) => {
      console.error(`[broadcasts] Redis pinActive failed for ${broadcast!.id} — falling back to Postgres-only`, err);
    });

    const fanoutData = {
      broadcastId: broadcast!.id,
      householdId: household.id,
      lon,
      lat,
      wasteType: wasteType ?? null,
      note: note ?? null,
      householdName: household.display_name,
      householdPhone: household.phone, // reveal is immediate for broadcasts — see design §10 / SRS NFR-Privacy
      radiusM,
    };
    // 5s timeout, not just .catch(): fanoutQueue.add() uses bullRedis, whose
    // maxRetriesPerRequest:null means a call against unreachable Redis retries forever rather
    // than ever rejecting — a bare .catch() never fires and this request hangs until the
    // client's own timeout, found live during tonight's Upstash quota incident. Found live,
    // one layer deeper: the enqueue call can also fail/time out *silently* under the same
    // Redis instability (BullMQ's own Lua-script-based commands, not just simple ones) — when
    // that happens the job never gets created at all, so no amount of resilience *inside*
    // processFanout helps, because processFanout is never invoked. Falls back to running the
    // exact same match-and-notify logic inline, right here, rather than silently losing the
    // fan-out for this broadcast entirely.
    await withTimeout(fanoutQueue.add("fanout", fanoutData), 5000, "fanoutQueue.add").catch(async (err) => {
      console.error(`[broadcasts] failed to enqueue fan-out for ${broadcast!.id} — running it inline instead`, err);
      await runFanoutLogic(fanoutData).catch((inlineErr) => {
        console.error(`[broadcasts] inline fan-out fallback also failed for ${broadcast!.id}`, inlineErr);
      });
    });

    res.status(201).json({ broadcast: { ...broadcast, status: "active" } });
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

    await withTimeout(presence.pinCleared(row.id), 3000, "presence.pinCleared").catch((err) => {
      console.error(`[broadcasts] Redis pinCleared failed for ${row.id} — Postgres is already cleared, degrading gracefully`, err);
    });

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

/**
 * GET /pins/nearby — collector's live map of nearby waste (design §5, Q2). Candidate IDs come
 * from Redis's `pins:active` GEO set (the hot path) merged with a direct Postgres geo query
 * (not just an error-triggered fallback — see redis/presence.ts's nearbyPinsMerged for why a
 * silently-incomplete Redis write can't be caught by error handling alone); details are joined
 * from Postgres, the durable source of truth for the broadcast itself either way.
 */
broadcastsRouter.get(
  "/pins/nearby",
  requireAuth,
  requireRole("collector"),
  validateQuery(nearbySchema),
  asyncHandler(async (req, res) => {
    const { lon, lat, radius } = req.query as unknown as { lon: number; lat: number; radius: number };
    const hits = await presence.nearbyPinsMerged(lon, lat, radius);
    if (hits.length === 0) return res.json({ pins: [] });

    const rows = await query<{ id: string; waste_type: string | null; note: string | null; created_at: string; expires_at: string; household_name: string | null; household_phone: string }>(
      `SELECT b.id, b.waste_type, b.note, b.created_at, b.expires_at,
              u.display_name AS household_name, u.phone AS household_phone
       FROM broadcasts b JOIN users u ON u.id = b.household_id
       WHERE b.status = 'active' AND b.id = ANY($1)`,
      [hits.map((h) => h.id)]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const pins = hits
      .map((h) => {
        const row = byId.get(h.id);
        if (!row) return null; // cleared/expired in Postgres but the sweep hasn't evicted Redis yet
        return { ...row, lon: h.lon, lat: h.lat, distance_m: h.distanceM };
      })
      .filter(Boolean);
    res.json({ pins });
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
