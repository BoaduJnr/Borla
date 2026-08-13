import "dotenv/config";
import http from "node:http";

import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { seedDemoData } from "./seed.js";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { startJobs } from "./jobs/index.js";

async function main() {
  await runMigrations();
  // Idempotent — ensures the graded demo/test credentials in Deployment_and_Source_Links.txt
  // always exist, even on a fresh database or after a redeploy.
  await seedDemoData();

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);
  startJobs();

  server.listen(config.port, () => {
    console.log(`[server] Borla API listening on :${config.port} (${config.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error("[server] fatal startup error", err);
  process.exit(1);
});
