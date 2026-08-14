import { sweepsQueue } from "./queues.js";

/**
 * Registers the repeatable sweeps on boot via BullMQ's Job Scheduler API (`upsertJobScheduler`)
 * — the modern, explicitly-idempotent replacement for the older `add(name, data, {repeat})`
 * pattern: calling this on every server start (including after a redeploy) with the same
 * schedulerId + repeat options is safe and never piles up duplicates.
 *
 * There were originally four; `review-release` (the double-blind reciprocal-release sweep) was
 * removed once reviews/replies were changed to go visible individually on their own moderation
 * pass instead of waiting on the other side (see Technical_Debt_Plan.md) — there is no longer
 * anything for a sweep to release.
 */
export async function scheduleRepeatableJobs() {
  // One-time cleanup: a scheduler registered under the old name would otherwise keep firing
  // forever in any environment that already had it running (e.g. production), now against a
  // job name no worker handles — removeJobScheduler on a scheduler that was never registered
  // (e.g. a fresh local/test database) is a harmless no-op, not an error.
  await sweepsQueue.removeJobScheduler("review-release-scheduler").catch(() => {});
  await Promise.all([
    sweepsQueue.upsertJobScheduler("presence-sweep-scheduler", { every: 30_000 }, { name: "presence-sweep" }),
    sweepsQueue.upsertJobScheduler("pin-expiry-scheduler", { every: 60_000 }, { name: "pin-expiry" }),
    sweepsQueue.upsertJobScheduler("request-timeout-scheduler", { every: 15_000 }, { name: "request-timeout" }),
  ]);
  console.log("[jobs] BullMQ repeatables scheduled: presence-sweep (30s), pin-expiry (60s), request-timeout (15s)");
}
