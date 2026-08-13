import cron from "node-cron";
import { query } from "../db/pool.js";
import { emitToUser } from "../realtime/socket.js";
import { getConfigNumber, AppConfigKeys, defaults } from "../utils/appConfig.js";

/**
 * In-process scheduled jobs, replacing the original design's BullMQ + Redis repeatable/delayed
 * jobs (Technical_Debt_Plan.md, TD-05). Trade-off accepted for a single free-tier Node instance:
 * no retries/backoff and all state resets on restart, but the semantics (self-healing presence,
 * pin auto-expiry, request timeout, double-blind review release) are preserved exactly.
 */

/** Presence sweep (design §6): honesty backstop if heartbeats stop without an explicit "offline". */
function presenceSweep() {
  cron.schedule("*/30 * * * * *", async () => {
    try {
      const rows = await query<{ user_id: string }>(
        `UPDATE collectors SET online = false
         WHERE online = true AND last_seen_at < now() - interval '90 seconds'
         RETURNING user_id`
      );
      if (rows.length) console.log(`[jobs] presence sweep: ${rows.length} collector(s) marked offline (stale heartbeat)`);
    } catch (err) {
      console.error("[jobs] presenceSweep failed", err);
    }
  });
}

/** Pin expiry (design §3.1): backstop for forgotten/stale broadcasts. */
function pinExpirySweep() {
  cron.schedule("0 * * * * *", async () => {
    try {
      const expired = await query<{ id: string }>(
        `UPDATE broadcasts SET status = 'expired', resolved_at = now()
         WHERE status = 'active' AND expires_at < now()
         RETURNING id`
      );
      for (const b of expired) {
        const notified = await query<{ collector_id: string }>(
          `SELECT collector_id FROM broadcast_notifications WHERE broadcast_id = $1`,
          [b.id]
        );
        for (const { collector_id } of notified) {
          emitToUser(collector_id, "broadcast:cleared", { broadcastId: b.id, reason: "expired" });
        }
      }
      if (expired.length) console.log(`[jobs] pin expiry: ${expired.length} broadcast(s) expired`);
    } catch (err) {
      console.error("[jobs] pinExpirySweep failed", err);
    }
  });
}

/** Request timeout (design §3.2): household must never stare at a silent screen. */
function requestTimeoutSweep() {
  cron.schedule("*/15 * * * * *", async () => {
    try {
      const timeoutSeconds = await getConfigNumber(AppConfigKeys.requestTimeoutSeconds, defaults.requestTimeoutSeconds);
      const rows = await query<{ id: string; household_id: string }>(
        `UPDATE requests SET status = 'timed_out', responded_at = now()
         WHERE status IN ('requested','seen')
           AND requested_at < now() - interval '${timeoutSeconds} seconds'
         RETURNING id, household_id`
      );
      for (const r of rows) emitToUser(r.household_id, "request:timed_out", { requestId: r.id });
      if (rows.length) console.log(`[jobs] request timeout: ${rows.length} request(s) timed out`);
    } catch (err) {
      console.error("[jobs] requestTimeoutSweep failed", err);
    }
  });
}

/**
 * Double-blind review release (design §16): reveal together once both sides have a
 * moderation-cleared review on the same interaction, or once the review window closes —
 * whichever comes first — then recompute the subject's rolling rating aggregate.
 */
function reviewReleaseSweep() {
  cron.schedule("*/2 * * * *", async () => {
    try {
      const bothSides = await query<{ id: string; subject_id: string }>(
        `UPDATE reviews r SET status = 'visible', visible_at = now()
         WHERE r.status = 'pending' AND r.moderation_passed = true
           AND EXISTS (
             SELECT 1 FROM reviews r2
             WHERE r2.status = 'pending' AND r2.moderation_passed = true AND r2.id <> r.id
               AND COALESCE(r2.request_id, r2.broadcast_id) = COALESCE(r.request_id, r.broadcast_id)
               AND r2.author_role <> r.author_role
           )
         RETURNING id, subject_id`
      );

      const windowDays = await getConfigNumber(AppConfigKeys.reviewWindowDays, defaults.reviewWindowDays);
      const windowClosed = await query<{ id: string; subject_id: string }>(
        `UPDATE reviews SET status = 'visible', visible_at = now()
         WHERE status = 'pending' AND moderation_passed = true
           AND created_at <= now() - interval '${windowDays} days'
         RETURNING id, subject_id`
      );

      const released = [...bothSides, ...windowClosed];
      const subjects = new Set(released.map((r) => r.subject_id));
      for (const subjectId of subjects) {
        await recomputeRatingAggregate(subjectId);
      }
      if (released.length) console.log(`[jobs] review release: ${released.length} review(s) made visible`);
    } catch (err) {
      console.error("[jobs] reviewReleaseSweep failed", err);
    }
  });
}

async function recomputeRatingAggregate(userId: string) {
  const agg = await query<{ avg: string; count: string; role: string }>(
    `SELECT AVG(rating)::numeric(3,2) AS avg, COUNT(*) AS count, u.role
     FROM reviews r JOIN users u ON u.id = r.subject_id
     WHERE r.subject_id = $1 AND r.status = 'visible'
     GROUP BY u.role`,
    [userId]
  );
  const row = agg[0];
  if (!row) return;
  const table = row.role === "collector" ? "collectors" : "households";
  await query(`UPDATE ${table} SET rating_avg = $1, rating_count = $2 WHERE user_id = $3`, [
    row.avg,
    row.count,
    userId,
  ]);
}

export function startJobs() {
  presenceSweep();
  pinExpirySweep();
  requestTimeoutSweep();
  reviewReleaseSweep();
  console.log("[jobs] scheduled: presence sweep (30s), pin expiry (60s), request timeout (15s), review release (2m)");
}
