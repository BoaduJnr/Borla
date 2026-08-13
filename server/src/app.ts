import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { config } from "./config.js";
import { errorHandler } from "./middleware/errorHandler.js";

import { authRouter } from "./modules/auth/routes.js";
import { presenceRouter } from "./modules/presence/routes.js";
import { broadcastsRouter } from "./modules/broadcasts/routes.js";
import { requestsRouter } from "./modules/requests/routes.js";
import { reviewsRouter } from "./modules/reviews/routes.js";
import { adminRouter } from "./modules/admin/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app without binding a port or starting sockets/jobs — used by both the
 * real server entrypoint (index.ts) and the Supertest integration tests, so tests exercise the
 * exact same middleware/route wiring as production instead of a hand-rolled subset.
 */
export function createApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.isProd ? true : config.clientOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  app.use(
    "/api/",
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false })
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use("/api/auth", authRouter);
  app.use("/api", presenceRouter);
  app.use("/api", broadcastsRouter);
  app.use("/api/requests", requestsRouter);
  app.use("/api", reviewsRouter);
  app.use("/api/admin", adminRouter);

  const clientDist = path.resolve(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });

  app.use(errorHandler);
  return app;
}
