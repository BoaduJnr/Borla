import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody } from "../../middleware/validate.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("admin"));

async function logAudit(adminId: string, action: string, targetId: string | null, meta: unknown = null) {
  await query(`INSERT INTO audit_log (admin_id, action, target_id, meta) VALUES ($1, $2, $3, $4)`, [
    adminId,
    action,
    targetId,
    meta ? JSON.stringify(meta) : null,
  ]);
}

/** GET /admin/stats — the north-star density + health metrics (design §17). */
adminRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const [users, broadcasts, requests, onlineCollectors, moderationBacklog] = await Promise.all([
      query(`SELECT role, count(*) FROM users GROUP BY role`),
      query(`SELECT status, count(*) FROM broadcasts GROUP BY status`),
      query(`SELECT status, count(*) FROM requests GROUP BY status`),
      query(`SELECT count(*) FROM collectors WHERE online = true`),
      query(`SELECT count(*) FROM moderation_flags WHERE resolved = false`),
    ]);
    res.json({
      usersByRole: users,
      broadcastsByStatus: broadcasts,
      requestsByStatus: requests,
      onlineCollectors: Number(onlineCollectors[0]?.count ?? 0),
      moderationBacklog: Number(moderationBacklog[0]?.count ?? 0),
    });
  })
);

/** GET /admin/live-map — active pins + online collector positions (design §17 "live ops view"). */
adminRouter.get(
  "/live-map",
  asyncHandler(async (_req, res) => {
    const [pins, collectors] = await Promise.all([
      query(`SELECT id, lon, lat, waste_type, status, created_at, expires_at FROM broadcasts WHERE status = 'active'`),
      query(
        `SELECT u.id, u.display_name, c.last_lon AS lon, c.last_lat AS lat, c.last_seen_at
         FROM collectors c JOIN users u ON u.id = c.user_id WHERE c.online = true`
      ),
    ]);
    res.json({ pins, collectors });
  })
);

/** GET /admin/users — search/browse for verification, suspension, and support. */
adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const role = req.query.role as string | undefined;
    const search = req.query.q as string | undefined;
    const rows = await query(
      `SELECT id, phone, role, display_name, verified, suspended, created_at
       FROM users
       WHERE ($1::text IS NULL OR role = $1)
         AND ($2::text IS NULL OR phone ILIKE '%'||$2||'%' OR display_name ILIKE '%'||$2||'%')
       ORDER BY created_at DESC LIMIT 200`,
      [role ?? null, search ?? null]
    );
    res.json({ users: rows });
  })
);

adminRouter.post(
  "/users/:id/verify",
  asyncHandler(async (req, res) => {
    const row = await queryOne(`UPDATE users SET verified = true WHERE id = $1 AND role = 'collector' RETURNING id`, [
      req.params.id,
    ]);
    if (!row) throw new ApiError(404, "Collector not found");
    await logAudit(req.user!.id, "verify_collector", req.params.id);
    res.json({ ok: true });
  })
);

adminRouter.post(
  "/users/:id/suspend",
  validateBody(z.object({ reason: z.string().max(200).optional() })),
  asyncHandler(async (req, res) => {
    const row = await queryOne(`UPDATE users SET suspended = true WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!row) throw new ApiError(404, "User not found");
    await logAudit(req.user!.id, "suspend_user", req.params.id, { reason: req.body.reason });
    res.json({ ok: true });
  })
);

adminRouter.post(
  "/users/:id/reinstate",
  asyncHandler(async (req, res) => {
    const row = await queryOne(`UPDATE users SET suspended = false WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!row) throw new ApiError(404, "User not found");
    await logAudit(req.user!.id, "reinstate_user", req.params.id);
    res.json({ ok: true });
  })
);

/**
 * GET /admin/moderation/queue — AI-flagged + user-reported items, PLUS (when no Gemini key is
 * configured) every review/reply still awaiting moderation at all — this is the manual-only
 * fallback path from Technical_Debt_Plan.md TD-01.
 */
adminRouter.get(
  "/moderation/queue",
  asyncHandler(async (_req, res) => {
    const flags = await query(
      `SELECT mf.id, mf.target_type, mf.target_id, mf.reason, mf.source, mf.score, mf.created_at,
              CASE WHEN mf.target_type = 'review' THEN r.comment ELSE rr.body END AS text,
              CASE WHEN mf.target_type = 'review' THEN r.author_id ELSE rr.author_id END AS author_id
       FROM moderation_flags mf
       LEFT JOIN reviews r ON mf.target_type = 'review' AND r.id = mf.target_id
       LEFT JOIN review_replies rr ON mf.target_type = 'reply' AND rr.id = mf.target_id
       WHERE mf.resolved = false
       ORDER BY mf.score DESC NULLS LAST, mf.created_at ASC`
    );
    const awaitingManual = await query(
      `SELECT id, 'review' AS target_type, comment AS text, author_id, created_at
       FROM reviews WHERE status = 'pending' AND moderation_passed = false
       UNION ALL
       SELECT id, 'reply' AS target_type, body AS text, author_id, created_at
       FROM review_replies WHERE status = 'pending' AND moderation_passed = false
       ORDER BY created_at ASC`
    );
    res.json({ flags, awaitingManual });
  })
);

adminRouter.post(
  "/moderation/flags/:id/resolve",
  validateBody(z.object({ action: z.enum(["remove", "clear"]), note: z.string().max(200).optional() })),
  asyncHandler(async (req, res) => {
    const flag = await queryOne<{ target_type: "review" | "reply"; target_id: string }>(
      `SELECT target_type, target_id FROM moderation_flags WHERE id = $1`,
      [req.params.id]
    );
    if (!flag) throw new ApiError(404, "Flag not found");
    const table = flag.target_type === "review" ? "reviews" : "review_replies";
    const newStatus = req.body.action === "remove" ? "removed" : "visible";
    await query(`UPDATE ${table} SET status = $1, moderation_passed = true WHERE id = $2`, [newStatus, flag.target_id]);
    await query(`UPDATE moderation_flags SET resolved = true, resolution = $1 WHERE id = $2`, [req.body.action, req.params.id]);
    await logAudit(req.user!.id, `moderation_${req.body.action}`, flag.target_id, { flagId: req.params.id, note: req.body.note });
    res.json({ ok: true });
  })
);

/** POST /admin/reviews/:id/approve — manual moderation pass (used when no Gemini key is set). */
adminRouter.post(
  "/reviews/:id/approve",
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `UPDATE reviews SET moderation_passed = true WHERE id = $1 AND status = 'pending' RETURNING id`,
      [req.params.id]
    );
    if (!row) throw new ApiError(404, "Pending review not found");
    await logAudit(req.user!.id, "manual_approve_review", req.params.id);
    res.json({ ok: true });
  })
);

adminRouter.post(
  "/reviews/:id/remove",
  asyncHandler(async (req, res) => {
    const row = await queryOne(`UPDATE reviews SET status = 'removed' WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!row) throw new ApiError(404, "Review not found");
    await logAudit(req.user!.id, "remove_review", req.params.id);
    res.json({ ok: true });
  })
);

/** GET /admin/audit-log — every privileged action, for accountability. */
adminRouter.get(
  "/audit-log",
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT al.id, al.action, al.target_id, al.meta, al.created_at, u.display_name AS admin_name
       FROM audit_log al LEFT JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC LIMIT 200`
    );
    res.json({ auditLog: rows });
  })
);

/** GET/PATCH /admin/config — live tuning without redeploy (design §17). */
adminRouter.get(
  "/config",
  asyncHandler(async (_req, res) => {
    const rows = await query(`SELECT key, value, updated_at FROM app_config ORDER BY key`);
    res.json({ config: rows });
  })
);

adminRouter.patch(
  "/config/:key",
  validateBody(z.object({ value: z.union([z.number(), z.string(), z.boolean()]) })),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `UPDATE app_config SET value = $1, updated_by = $2, updated_at = now() WHERE key = $3 RETURNING key, value`,
      [JSON.stringify(req.body.value), req.user!.id, req.params.key]
    );
    if (!row) throw new ApiError(404, "Unknown config key");
    await logAudit(req.user!.id, "update_config", null, { key: req.params.key, value: req.body.value });
    res.json({ config: row });
  })
);
