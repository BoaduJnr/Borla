import { Router } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { queryOne, query } from "../../db/pool.js";
import { asyncHandler, ApiError } from "../../middleware/errorHandler.js";
import { validateBody } from "../../middleware/validate.js";
import { phoneSchema } from "../auth/routes.js";
import { sendSms, isSmsConfigured } from "../../utils/sms.js";
import { generateShareToken, hashShareToken } from "../../utils/routeShareToken.js";
import { checkRouteShareTargetLimit, checkRouteShareSenderLimit } from "../../redis/rateLimit.js";

export const routeShareRouter = Router();

const ROUTE_SHARE_TTL_MINUTES = 30;

const createSchema = z.object({
  phone: phoneSchema,
  senderLon: z.number().min(-180).max(180),
  senderLat: z.number().min(-90).max(90),
});

/**
 * POST /route-share — no login required (splash-screen entry point, by design). Texts the given
 * phone a link to an unauthenticated route map back to the sender's current position. Always
 * anonymous: the recipient is never told who sent it, only that "someone" did.
 */
routeShareRouter.post(
  "/route-share",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { phone, senderLon, senderLat } = req.body as { phone: string; senderLon: number; senderLat: number };
    const ip = req.ip ?? "unknown";

    // Both limits guard different abuse shapes — see rateLimit.ts's comment on why OTP's
    // single per-number limit isn't enough here (the number being texted belongs to a stranger,
    // not the caller).
    if (!(await checkRouteShareSenderLimit(ip))) {
      throw new ApiError(429, "Too many links created — wait a while and try again");
    }
    if (!(await checkRouteShareTargetLimit(phone))) {
      throw new ApiError(429, "Too many links already sent to this number — wait a while and try again");
    }

    const token = generateShareToken();
    const tokenHash = hashShareToken(token);
    await query(
      `INSERT INTO route_shares (token_hash, sender_lon, sender_lat, phone, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '${ROUTE_SHARE_TTL_MINUTES} minutes')`,
      [tokenHash, senderLon, senderLat, phone]
    );

    // In prod the client and API share one Render origin (app.ts serves the built SPA for any
    // non-/api path), so the request's own host is the correct place to point the link. In dev
    // the API (4000) and Vite client (5173) are different origins with only a one-way /api
    // proxy, so the link must point at the Vite dev server instead or it 404s against a
    // client/dist that doesn't exist yet.
    const origin = config.isProd ? `${req.protocol}://${req.get("host")}` : config.clientOrigin;
    const link = `${origin}/route/${token}`;

    let delivered = false;
    if (isSmsConfigured()) {
      const result = await sendSms(
        phone,
        `Someone on Borla wants you to find them: ${link} (expires in ${ROUTE_SHARE_TTL_MINUTES} minutes)`
      );
      delivered = result.ok;
      if (!result.ok) console.error(`[routeShare] SMS delivery failed for ${phone}: ${result.error} — falling back to devLink`);
    }

    res.json({
      delivered,
      expiresInMinutes: ROUTE_SHARE_TTL_MINUTES,
      // Best-effort, same spirit as otp/request's devOtp: a failed/unconfigured SMS send should
      // never leave the sender stuck with no way to hand the link over.
      devLink: delivered ? undefined : link,
    });
  })
);

/**
 * GET /route-share/:token — public lookup for the recipient's page. Deliberately returns only
 * the sender's coordinates, never `phone` or any other identity — the "always anonymous"
 * product decision is enforced here, not just left to the client to honor.
 */
routeShareRouter.get(
  "/route-share/:token",
  asyncHandler(async (req, res) => {
    const tokenHash = hashShareToken(req.params.token);
    const row = await queryOne<{ sender_lon: number; sender_lat: number; expires_at: string }>(
      `SELECT sender_lon, sender_lat, expires_at FROM route_shares WHERE token_hash = $1`,
      [tokenHash]
    );
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new ApiError(404, "This link has expired or doesn't exist");
    }
    res.json({ senderLon: row.sender_lon, senderLat: row.sender_lat, expiresAt: row.expires_at });
  })
);
