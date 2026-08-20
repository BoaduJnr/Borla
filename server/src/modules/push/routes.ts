import { Router } from "express";
import { z } from "zod";
import { query } from "../../db/pool.js";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { validateBody } from "../../middleware/validate.js";
import { requireAuth } from "../../middleware/auth.js";
import { config } from "../../config.js";

export const pushRouter = Router();

/**
 * Public: the client needs this to call PushManager.subscribe({ applicationServerKey: ... })
 * before the user has necessarily signed in on this device (e.g. right after a fresh install).
 * Not secret — the VAPID *public* key is meant to be shared; only the private key (server-only,
 * never sent anywhere) is what actually proves a push message came from Borla. Returns null,
 * not an error, when push isn't configured yet — same fail-open-to-"feature just isn't on"
 * pattern as everywhere else a missing key degrades gracefully (Gemini moderation, GiantSMS).
 */
pushRouter.get("/push/vapid-public-key", (_req, res) => {
  res.json({ publicKey: config.vapid.publicKey || null });
});

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/**
 * POST /push/subscribe — called once the user grants notification permission and the browser
 * hands back a PushSubscription (client sends its own .toJSON() shape directly, hence the
 * endpoint/keys.p256dh/keys.auth field names matching the Push API rather than snake_case).
 * ON CONFLICT (endpoint): the same browser subscription re-subscribing (token rotation, or a
 * shared/borrowed device switching accounts) updates which user it belongs to instead of
 * erroring or leaving a stale duplicate.
 */
pushRouter.post(
  "/push/subscribe",
  requireAuth,
  validateBody(subscribeSchema),
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body as z.infer<typeof subscribeSchema>;
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user!.id, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ ok: true });
  })
);

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

/** POST /push/unsubscribe — scoped to the caller's own subscriptions; can't delete anyone else's. */
pushRouter.post(
  "/push/unsubscribe",
  requireAuth,
  validateBody(unsubscribeSchema),
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body as z.infer<typeof unsubscribeSchema>;
    await query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.user!.id]);
    res.json({ ok: true });
  })
);
