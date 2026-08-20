import express, { type Request } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { config } from "./config.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { pool } from "./db/pool.js";
import { redis } from "./redis/client.js";
import { verifyAccessToken } from "./utils/jwt.js";

import { authRouter } from "./modules/auth/routes.js";
import { presenceRouter } from "./modules/presence/routes.js";
import { broadcastsRouter } from "./modules/broadcasts/routes.js";
import { requestsRouter } from "./modules/requests/routes.js";
import { reviewsRouter } from "./modules/reviews/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { routeShareRouter } from "./modules/routeShare/routes.js";
import { landmarksRouter } from "./modules/landmarks/routes.js";
import { pushRouter } from "./modules/push/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app without binding a port or starting sockets/jobs — used by both the
 * real server entrypoint (index.ts) and the Supertest integration tests, so tests exercise the
 * exact same middleware/route wiring as production instead of a hand-rolled subset.
 */
export function createApp() {
  const app = express();
  // Render terminates TLS and proxies to this app over exactly one hop — without this, req.ip
  // is the proxy's own address (not the real visitor) and req.protocol always reports "http",
  // both of which matter now that an anonymous, unauthenticated endpoint (POST /route-share)
  // rate-limits by IP and builds an absolute link from req.protocol/req.get("host").
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.isProd ? true : config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Keyed by authenticated user id when the request carries a valid access token, falling back
  // to IP only for unauthenticated calls (login, OTP request, health check, ...). Plain per-IP
  // keying was measured (see the concurrent-user assessment this followed from) to throttle
  // innocent users well before it caught anything: idle client-side polling alone runs several
  // real users behind one shared IP (office wifi, campus NAT, a household on one router) into
  // the same 120/min bucket. Best-effort only — never throws, never blocks the request; an
  // invalid/expired/missing token just falls through to the IP-keyed behaviour this already had.
  function rateLimitKey(req: Request): string {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const payload = verifyAccessToken(header.slice("Bearer ".length));
        if (payload.type === "access") return `user:${payload.sub}`;
      } catch {
        // invalid/expired token — fall through to IP-keyed limiting below, same as no token at all
      }
    }
    return req.ip ?? "unknown";
  }

  app.use(
    "/api/",
    // The real, enforced production limit is 120/min per identity (see rateLimitKey above).
    // Vitest's supertest calls all originate from the same loopback "IP" within one shared app
    // instance per test file, so as the suite has grown, a single heavily-exercised file can
    // legitimately make well over 120 requests inside one 60s window — a test-harness artifact of
    // this specific generic safety-net middleware, not a real security behaviour under test (no
    // test anywhere asserts on its exact threshold). Effectively uncapped outside production so
    // test-suite growth never trips it again; the production number itself is untouched.
    rateLimit({
      windowMs: 60_000,
      limit: config.isProd ? 120 : 100_000,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: rateLimitKey,
    })
  );

  // Actively checks both dependencies rather than just answering "the process is up" — the
  // BullMQ/Upstash incident this was added right after (a hard monthly Redis command quota,
  // "max requests limit exceeded", rejecting every Redis command for the rest of the billing
  // period) would have been invisible from a bare 200 for as long as it lasted. Deliberately
  // does NOT let Redis being down affect the overall status/HTTP code: Postgres is the one
  // dependency every route genuinely needs, Redis degrades presence/fan-out/moderation/rate-
  // limiting but the app is still meaningfully usable without it (and this is the render.yaml
  // healthCheckPath — if Redis being down also failed this check, Render would consider an
  // otherwise-working deploy unhealthy and could restart it on a loop for no benefit, since a
  // restart doesn't fix an exhausted quota). Each check gets its own timeout so a hung
  // dependency can't make the health check itself hang.
  app.get("/api/health", async (_req, res) => {
    const withTimeout = <T,>(p: Promise<T>, ms: number) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);

    const [db, redisHealth] = await Promise.all([
      withTimeout(pool.query("SELECT 1"), 3000)
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })),
      withTimeout(redis.ping(), 3000)
        .then(() => ({ ok: true as const }))
        .catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })),
    ]);

    res.status(db.ok ? 200 : 503).json({ ok: db.ok, time: new Date().toISOString(), db, redis: redisHealth });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", presenceRouter);
  app.use("/api", broadcastsRouter);
  app.use("/api/requests", requestsRouter);
  app.use("/api", reviewsRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api", routeShareRouter);
  app.use("/api", landmarksRouter);
  app.use("/api", pushRouter);

  const clientDist = path.resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.use(errorHandler);
  return app;
}
