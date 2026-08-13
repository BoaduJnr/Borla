import "dotenv/config";
import { beforeAll, afterAll } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";
import { closeRedis } from "../src/redis/client.js";
import { startWorkers, closeWorkers, closeQueues } from "../src/jobs/index.js";

// Requires a real Postgres+PostGIS instance reachable at DATABASE_URL, and a real Redis
// instance at REDIS_URL (see server/.env or server/.env.example — point this at a local Redis,
// not the production Upstash instance) — these are integration tests, not mocked, per the
// exam's requirement for evidence of real integration testing.
//
// Workers must actually run here: broadcast fan-out and review/reply moderation are now BullMQ
// jobs (Technical_Debt_Plan.md TD-05), not synchronous work inside the route handler — a test
// that creates a broadcast and immediately asserts on its side effects needs a live worker to
// process that job, exactly like production does.
beforeAll(async () => {
  await runMigrations();
  startWorkers();
});

afterAll(async () => {
  await closeWorkers();
  await closeQueues();
  await closeRedis();
  await pool.end();
});
