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
/**
 * upsertJobScheduler calls a Redis Lua script under the hood — if whatever this scheduler ID
 * already has stored in Redis is in a state that script doesn't expect (e.g. a key partially
 * evicted under free-tier Redis memory pressure, leaving related BullMQ keys inconsistent with
 * each other), the call throws instead of just fixing itself up. Found live in production: this
 * crashed the *entire server* on every boot (an uncaught rejection here propagated all the way
 * up through main()), which is a wildly disproportionate blast radius for "one background sweep
 * couldn't re-register." Retries a couple of times first (covers a transient network blip),
 * then falls back to clearing this scheduler's own state and recreating it from scratch — a
 * scheduler is fully described by its (id, repeat options, job template), so there's nothing
 * unrecoverable about wiping and redoing it.
 */
async function upsertSweepResilient(schedulerId: string, everyMs: number, jobName: string) {
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      await sweepsQueue.upsertJobScheduler(schedulerId, { every: everyMs }, { name: jobName });
      return;
    } catch (err) {
      const isLast = i === attempts - 1;
      console.error(`[jobs] upsertJobScheduler(${schedulerId}) attempt ${i + 1}/${attempts} failed:`, err);
      if (!isLast) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      console.error(`[jobs] giving up retrying ${schedulerId} as-is — clearing its Redis state and recreating it once more`);
      await sweepsQueue.removeJobScheduler(schedulerId).catch(() => {});
      await sweepsQueue.upsertJobScheduler(schedulerId, { every: everyMs }, { name: jobName });
    }
  }
}

export async function scheduleRepeatableJobs() {
  // One-time cleanup: a scheduler registered under the old name would otherwise keep firing
  // forever in any environment that already had it running (e.g. production), now against a
  // job name no worker handles — removeJobScheduler on a scheduler that was never registered
  // (e.g. a fresh local/test database) is a harmless no-op, not an error.
  await sweepsQueue.removeJobScheduler("review-release-scheduler").catch(() => {});
  await Promise.all([
    upsertSweepResilient("presence-sweep-scheduler", 30_000, "presence-sweep"),
    upsertSweepResilient("pin-expiry-scheduler", 60_000, "pin-expiry"),
    upsertSweepResilient("request-timeout-scheduler", 15_000, "request-timeout"),
  ]);
  console.log("[jobs] BullMQ repeatables scheduled: presence-sweep (30s), pin-expiry (60s), request-timeout (15s)");
}
