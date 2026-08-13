import { sweepsQueue } from "./queues.js";

/**
 * Registers the four repeatable sweeps on boot via BullMQ's Job Scheduler API
 * (`upsertJobScheduler`) — the modern, explicitly-idempotent replacement for the older
 * `add(name, data, {repeat})` pattern: calling this on every server start (including after a
 * redeploy) with the same schedulerId + repeat options is safe and never piles up duplicates.
 */
export async function scheduleRepeatableJobs() {
  await Promise.all([
    sweepsQueue.upsertJobScheduler("presence-sweep-scheduler", { every: 30_000 }, { name: "presence-sweep" }),
    sweepsQueue.upsertJobScheduler("pin-expiry-scheduler", { every: 60_000 }, { name: "pin-expiry" }),
    sweepsQueue.upsertJobScheduler("request-timeout-scheduler", { every: 15_000 }, { name: "request-timeout" }),
    sweepsQueue.upsertJobScheduler("review-release-scheduler", { every: 120_000 }, { name: "review-release" }),
  ]);
  console.log("[jobs] BullMQ repeatables scheduled: presence-sweep (30s), pin-expiry (60s), request-timeout (15s), review-release (2m)");
}
