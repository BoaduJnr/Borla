import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody } from "../../middleware/validate.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { emitToUser } from "../../realtime/socket.js";

export const requestsRouter = Router();

const createSchema = z.object({
  collectorId: z.string().uuid(),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  wasteType: z.enum(["general", "recyclable", "organic", "bulky"]).optional(),
  note: z.string().max(280).optional(),
});

/** POST /requests — the request plane (design §3.2): a household picks one specific collector. */
requestsRouter.post(
  "/",
  requireAuth,
  requireRole("household"),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { collectorId, lon, lat, wasteType, note } = req.body as z.infer<typeof createSchema>;

    const collector = await queryOne<{ online: boolean; user_id: string }>(
      `SELECT c.online, c.user_id FROM collectors c
       JOIN users u ON u.id = c.user_id
       WHERE c.user_id = $1 AND u.suspended = false`,
      [collectorId]
    );
    if (!collector) throw new ApiError(404, "Collector not found");
    if (!collector.online) throw new ApiError(409, "That collector is currently offline");

    const row = await queryOne(
      `INSERT INTO requests (household_id, collector_id, lon, lat, location, waste_type, note)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
       RETURNING id, status, requested_at`,
      [req.user!.id, collectorId, lon, lat, wasteType ?? null, note ?? null]
    );

    emitToUser(collectorId, "request:new", {
      requestId: row!.id,
      householdId: req.user!.id,
      householdName: req.user!.display_name,
      lon,
      lat,
      wasteType: wasteType ?? null,
      note: note ?? null,
    });

    res.status(201).json({ request: row });
  })
);

/**
 * GET /requests/mine — requests sent (household) or received (collector).
 *
 * Also carries the location each side needs to route to the other once a request is accepted
 * (the introduce-a-route feature): a household's pickup point (`r.lon/r.lat`) was never
 * privacy-gated — the target collector already receives it in the `request:new` socket event
 * the moment the request is created — so it's included unconditionally here too. A collector's
 * *live* position is a different matter: it's only meaningful, and only shared, once they've
 * actually accepted (same reveal-on-accept timing as the phone number in GET /requests/:id).
 */
requestsRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const rows =
      user.role === "household"
        ? await query(
            `SELECT r.id, r.status, r.waste_type, r.note, r.requested_at, r.responded_at,
                    u.id AS collector_id, u.display_name AS collector_name,
                    CASE WHEN r.status = 'accepted' THEN c.last_lon END AS collector_lon,
                    CASE WHEN r.status = 'accepted' THEN c.last_lat END AS collector_lat
             FROM requests r
             JOIN users u ON u.id = r.collector_id
             LEFT JOIN collectors c ON c.user_id = r.collector_id
             WHERE r.household_id = $1 ORDER BY r.requested_at DESC LIMIT 50`,
            [user.id]
          )
        : await query(
            `SELECT r.id, r.status, r.waste_type, r.note, r.requested_at, r.responded_at,
                    r.lon AS household_lon, r.lat AS household_lat,
                    u.id AS household_id, u.display_name AS household_name
             FROM requests r JOIN users u ON u.id = r.household_id
             WHERE r.collector_id = $1 ORDER BY r.requested_at DESC LIMIT 50`,
            [user.id]
          );
    res.json({ requests: rows });
  })
);

/** GET /requests/:id — poll fallback (design §13); reveals contact only once accepted. */
requestsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await queryOne<any>(
      `SELECT r.*, hu.display_name AS household_name, hu.phone AS household_phone,
              cu.display_name AS collector_name, cu.phone AS collector_phone
       FROM requests r
       JOIN users hu ON hu.id = r.household_id
       JOIN users cu ON cu.id = r.collector_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Request not found");
    const user = req.user!;
    if (row.household_id !== user.id && row.collector_id !== user.id) {
      throw new ApiError(403, "Not part of this request");
    }
    if (row.status !== "accepted") {
      delete row.household_phone;
      delete row.collector_phone;
    }
    res.json({ request: row });
  })
);

/** POST /requests/:id/seen — collector's client acknowledges receipt (design §3.2). */
requestsRouter.post(
  "/:id/seen",
  requireAuth,
  requireRole("collector"),
  asyncHandler(async (req, res) => {
    const row = await queryOne<{ id: string; household_id: string }>(
      `UPDATE requests SET status = 'seen' WHERE id = $1 AND collector_id = $2 AND status = 'requested'
       RETURNING id, household_id`,
      [req.params.id, req.user!.id]
    );
    // Zero rows = already resolved (accepted/rejected/timed_out) — idempotent no-op, not an error.
    if (row) emitToUser(row.household_id, "request:seen", { requestId: row.id });
    res.json({ ok: true });
  })
);

/**
 * Accept/reject share the same idempotency guard from design §3.2: a conditional
 * `WHERE status IN ('requested','seen')` update, treating zero-rows-affected as
 * "already resolved" rather than an error — this is what stops a reject arriving after a
 * timeout from resurrecting the request.
 */
requestsRouter.post(
  "/:id/accept",
  requireAuth,
  requireRole("collector"),
  asyncHandler(async (req, res) => {
    const row = await queryOne<{ id: string; household_id: string }>(
      `UPDATE requests SET status = 'accepted', responded_at = now(), contact_revealed_at = now()
       WHERE id = $1 AND collector_id = $2 AND status IN ('requested','seen')
       RETURNING id, household_id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new ApiError(409, "This request is no longer pending (already resolved or timed out)");
    emitToUser(row.household_id, "request:accepted", { requestId: row.id });
    res.json({ ok: true });
  })
);

requestsRouter.post(
  "/:id/reject",
  requireAuth,
  requireRole("collector"),
  asyncHandler(async (req, res) => {
    const row = await queryOne<{ id: string; household_id: string }>(
      `UPDATE requests SET status = 'rejected', responded_at = now()
       WHERE id = $1 AND collector_id = $2 AND status IN ('requested','seen')
       RETURNING id, household_id`,
      [req.params.id, req.user!.id]
    );
    if (!row) throw new ApiError(409, "This request is no longer pending (already resolved or timed out)");
    emitToUser(row.household_id, "request:rejected", { requestId: row.id });
    res.json({ ok: true });
  })
);
