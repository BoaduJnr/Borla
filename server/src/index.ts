import "dotenv/config";
import http from "node:http";

import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./app.js";
import { initSocket } from "./realtime/socket.js";
import { startJobs } from "./jobs/index.js";

async function main() {
  await runMigrations();

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
