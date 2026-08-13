import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody } from "../../middleware/validate.js";
import { requireAuth } from "../../middleware/auth.js";
import { moderateReviewAsync, moderateReplyAsync } from "../../ai/moderation.js";

export const reviewsRouter = Router();

const createSchema = z
  .object({
    subjectId: z.string().uuid(),
    requestId: z.string().uuid().optional(),
    broadcastId: z.string().uuid().optional(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.requestId) !== Boolean(v.broadcastId), {
    message: "Provide exactly one of requestId or broadcastId",
  });

/**
 * POST /reviews — two-sided ratings (design §16). Non-negotiable: every review must reference
 * a real, resolved interaction, enforced here (not just by the DB unique constraints) so the
 * error message is actionable.
 */
reviewsRouter.post(
  "/reviews",
  requireAuth,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const author = req.user!;
    const { subjectId, requestId, broadcastId, rating, comment } = req.body as z.infer<typeof createSchema>;

    if (subjectId === author.id) throw new ApiError(400, "You cannot review yourself");

    if (requestId) {
      const request = await queryOne<{ household_id: string; collector_id: string; status: string }>(
        `SELECT household_id, collector_id, status FROM requests WHERE id = $1`,
        [requestId]
      );
      if (!request || request.status !== "accepted") {
        throw new ApiError(400, "Reviews are only allowed on accepted requests");
      }
      const parties = [request.household_id, request.collector_id];
      if (!parties.includes(author.id) || !parties.includes(subjectId) || author.id === subjectId) {
        throw new ApiError(403, "You may only review the other party in this request");
      }
    } else {
      const confirmation = await queryOne(
        `SELECT id FROM pickup_confirmations
         WHERE broadcast_id = $1 AND came = true
           AND (household_id = $2 OR collector_id = $2)
           AND (household_id = $3 OR collector_id = $3)`,
        [broadcastId, author.id, subjectId]
      );
      if (!confirmation) throw new ApiError(400, "Reviews on a broadcast require a confirmed pickup between these two parties");
    }

    let row;
    try {
      row = await queryOne(
        `INSERT INTO reviews (author_id, subject_id, author_role, request_id, broadcast_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [author.id, subjectId, author.role, requestId ?? null, broadcastId ?? null, rating, comment ?? null]
      );
    } catch (err: any) {
      if (err?.code === "23505") throw new ApiError(409, "You already reviewed this interaction");
      throw err;
    }

    // Enqueue, don't await the classification itself — a slow/failed Gemini call must never
    // block the response; a failure to even *enqueue* (e.g. Redis hiccup) is logged but still
    // doesn't fail the review creation, which already committed.
    await moderateReviewAsync(row!.id, comment ?? "").catch((err) => console.error("[reviews] failed to enqueue moderation", err));
    res.status(201).json({ review: { id: row!.id, status: "pending" } });
  })
);

/** GET /users/:id/reviews — paginated, visible only. */
reviewsRouter.get(
  "/users/:id/reviews",
  requireAuth,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 20;
    const rows = await query(
      `SELECT r.id, r.rating, r.comment, r.author_role, r.created_at, r.visible_at,
              a.display_name AS author_name,
              rr.body AS reply_body, rr.created_at AS reply_created_at
       FROM reviews r
       JOIN users a ON a.id = r.author_id
       LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.status = 'visible'
       WHERE r.subject_id = $1 AND r.status = 'visible'
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, pageSize, (page - 1) * pageSize]
    );
    res.json({ reviews: rows, page });
  })
);

/**
 * GET /reviews/mine — reviews the current user has *written*, any status. Reviews received
 * (GET /users/:id/reviews) only ever returns `status='visible'` rows, by design — a review
 * sits hidden until the double-blind release condition is met (both sides reviewed, or the
 * review window closed; `jobs/workers.ts` reviewReleaseSweep). Without this endpoint, the
 * author of a review has no way to confirm it was actually submitted and is just waiting on
 * the other side, rather than lost — this is exactly that visibility.
 */
reviewsRouter.get(
  "/reviews/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT r.id, r.rating, r.comment, r.status, r.moderation_passed, r.created_at, r.visible_at,
              s.display_name AS subject_name
       FROM reviews r
       JOIN users s ON s.id = r.subject_id
       WHERE r.author_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [req.user!.id]
    );
    res.json({ reviews: rows });
  })
);

/** POST /reviews/:id/reply — the reviewed party gets exactly one public reply. */
reviewsRouter.post(
  "/reviews/:id/reply",
  requireAuth,
  validateBody(z.object({ body: z.string().min(1).max(500) })),
  asyncHandler(async (req, res) => {
    const review = await queryOne<{ subject_id: string; status: string }>(
      `SELECT subject_id, status FROM reviews WHERE id = $1`,
      [req.params.id]
    );
    if (!review) throw new ApiError(404, "Review not found");
    if (review.subject_id !== req.user!.id) throw new ApiError(403, "Only the reviewed party may reply");
    if (review.status !== "visible") throw new ApiError(400, "Cannot reply until the review is published");

    let row;
    try {
      row = await queryOne(
        `INSERT INTO review_replies (review_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [req.params.id, req.user!.id, req.body.body]
      );
    } catch (err: any) {
      if (err?.code === "23505") throw new ApiError(409, "This review already has a reply");
      throw err;
    }
    await moderateReplyAsync(row!.id, req.body.body).catch((err) => console.error("[reviews] failed to enqueue moderation", err));
    res.status(201).json({ reply: { id: row!.id, status: "pending" } });
  })
);

/** POST /reviews/:id/report — any party flags a review for the human moderation queue. */
reviewsRouter.post(
  "/reviews/:id/report",
  requireAuth,
  validateBody(z.object({ reason: z.string().min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const review = await queryOne(`SELECT id FROM reviews WHERE id = $1`, [req.params.id]);
    if (!review) throw new ApiError(404, "Review not found");
    await query(
      `INSERT INTO moderation_flags (target_type, target_id, reason, source) VALUES ('review', $1, $2, 'user_report')`,
      [req.params.id, req.body.reason]
    );
    res.status(201).json({ ok: true });
  })
);
