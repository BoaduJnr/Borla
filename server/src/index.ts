import "dotenv/config";
import http from "node:http";

import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { seedDemoData } from "./seed.js";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { scheduleRepeatableJobs, startWorkers } from "./jobs/index.js";

async function main() {
  await runMigrations();
  // Idempotent — ensures the graded demo/test credentials in Deployment_and_Source_Links.txt
  // always exist, even on a fresh database or after a redeploy.
  await seedDemoData();

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);

  // BullMQ (Technical_Debt_Plan.md TD-05): workers must be running before jobs get enqueued,
  // and the repeatable sweeps are registered once per boot (BullMQ dedupes identical repeats).
  // Registering the sweeps is best-effort at boot, deliberately non-fatal: a Redis/BullMQ hiccup
  // here (a scheduler's own retry+cleanup in scheduleRepeatableJobs() already covers the common
  // case) must never take down the whole API — the background sweeps matter, but "the entire
  // app is unreachable" is a wildly disproportionate failure mode for "one sweep didn't
  // re-register," and is exactly what happened in production once already.
  startWorkers();
  try {
    await scheduleRepeatableJobs();
  } catch (err) {
    console.error("[jobs] failed to schedule repeatable sweeps after retrying — starting the server anyway", err);
  }

  server.listen(config.port, () => {
    console.log(`[server] Borla API listening on :${config.port} (${config.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error", err);
  process.exit(1);
});
