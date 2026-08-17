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

// Same reasoning as app.ts's own global rate limiter: every integration-test request shares one
// real loopback IP across the whole (fileParallelism:false) test run, so a low production cap
// keyed by IP trips for real once enough tests exist, with no way for any individual test to
// avoid it. app.ts's comment already documents this exact class of problem and its fix —
// "effectively uncapped outside production so test-suite growth never trips it again; the
// production number itself is untouched."
const ROUTE_SHARE_SENDER_LIMIT = config.isProd ? 5 : 100_000;

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
    if (!(await checkRouteShareSenderLimit(ip, ROUTE_SHARE_SENDER_LIMIT))) {
      throw new ApiError(429, "Too many links created — wait a while and try again");
    }
    if (!(await checkRouteShareTargetLimit(phone))) {
      throw new ApiError(429, "Too many links already sent to this number — wait a while and try again");
    }

    // Token + link are pure/local — neither needs the row to exist yet, so SMS delivery can be
    // attempted (and its real outcome known) before the row is ever inserted, letting `delivered`
    // be persisted on the same INSERT instead of computed after the fact and thrown away.
    const token = generateShareToken();
    const tokenHash = hashShareToken(token);

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

    await query(
      `INSERT INTO route_shares (token_hash, sender_lon, sender_lat, phone, delivered, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '${ROUTE_SHARE_TTL_MINUTES} minutes')`,
      [tokenHash, senderLon, senderLat, phone, delivered]
    );

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

const FOUND_RADIUS_M = 150;

const checkinSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});

/**
 * POST /route-share/:token/checkin — the recipient's page pings this as its own position
 * updates. Unlike POST /requests/:id/arrived, there's no independent, server-known position to
 * re-verify a client-supplied lon/lat against here (the recipient is anonymous, with no account
 * and no streamed presence) — self-reported coordinates are the only signal available, so
 * "found" is necessarily a soft, informational marker for ops visibility, not a business-critical
 * boundary the way arrival is (nothing is paid, rated, or unlocked by it). No new rate limiter:
 * this only writes to a row the caller already holds an unguessable token for, and costs nothing
 * to call (no SMS, no new PII exposure) — a materially lower-risk surface than POST /route-share.
 */
routeShareRouter.post(
  "/route-share/:token/checkin",
  validateBody(checkinSchema),
  asyncHandler(async (req, res) => {
    const { lon, lat } = req.body as { lon: number; lat: number };
    const tokenHash = hashShareToken(req.params.token);

    const row = await queryOne<{ expires_at: string; found_at: string | null }>(
      `SELECT expires_at, found_at FROM route_shares WHERE token_hash = $1`,
      [tokenHash]
    );
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new ApiError(404, "This link has expired or doesn't exist");
    }

    // First-fix latch — "where did the recipient originally start from", never overwritten by
    // later pings as they keep moving. Independent of the found-radius check below.
    await query(
      `UPDATE route_shares SET receiver_lon = $2, receiver_lat = $3
       WHERE token_hash = $1 AND receiver_lon IS NULL`,
      [tokenHash, lon, lat]
    );

    let found = row.found_at != null;
    if (!found) {
      // Same ST_DWithin-on-geography idiom requests/routes.ts uses for the arrival radius, just
      // computed inline from the two existing DOUBLE PRECISION columns rather than a stored
      // geography column — this is always a single row already selected by token_hash, never a
      // nearby-search, so no spatial index is needed.
      const foundRow = await queryOne<{ found_at: string }>(
        `UPDATE route_shares
         SET found_at = now()
         WHERE token_hash = $1
           AND found_at IS NULL
           AND ST_DWithin(
                 ST_SetSRID(ST_MakePoint(sender_lon, sender_lat), 4326)::geography,
                 ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                 $4
               )
         RETURNING found_at`,
        [tokenHash, lon, lat, FOUND_RADIUS_M]
      );
      found = Boolean(foundRow);
    }

    res.json({ found });
  })
);
