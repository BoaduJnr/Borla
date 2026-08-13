import "dotenv/config";
import { beforeAll, afterAll } from "vitest";
import { runMigrations } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";

// Requires a real Postgres+PostGIS instance reachable at DATABASE_URL (see server/.env or
// server/.env.example) — these are integration tests, not mocked, per the exam's requirement
// for evidence of real integration testing.
beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await pool.end();
});
