import { Worker, type Job } from "bullmq";
import { bullRedis } from "../redis/client.js";
import { query } from "../db/pool.js";
import { emitToUser } from "../realtime/socket.js";
import { getConfigNumber, AppConfigKeys, defaults } from "../utils/appConfig.js";
import { sweepStalePresence, pinCleared, nearbyCollectors } from "../redis/presence.js";
import { checkNotifRateLimit } from "../redis/rateLimit.js";
import { inQuietHours } from "../utils/quietHours.js";
import { classifyText } from "../ai/moderation.js";

const connection = bullRedis;

// ---------------------------------------------------------------- sweeps (repeatable)

/** Presence sweep (design §6): Redis is authoritative; Postgres is mirrored for durability/reads. */
async function presenceSweep() {
  const staleIds = await sweepStalePresence(90); // 90s, matching the original design's TTL slack
  if (staleIds.length === 0) return;
  await query(`UPDATE collectors SET online = false WHERE user_id = ANY($1)`, [staleIds]);
  console.log(`[jobs] presence sweep: ${staleIds.length} collector(s) marked offline (stale heartbeat)`);
}

/** Pin expiry (design §3.1): backstop for forgotten/stale broadcasts. */
async function pinExpirySweep() {
  const expired = await query<{ id: string }>(
    `UPDATE broadcasts SET status = 'expired', resolved_at = now()
     WHERE status = 'active' AND expires_at < now()
     RETURNING id`
  );
  for (const b of expired) {
    await pinCleared(b.id);
    const notified = await query<{ collector_id: string }>(
      `SELECT collector_id FROM broadcast_notifications WHERE broadcast_id = $1`,
      [b.id]
    );
    for (const { collector_id } of notified) {
      emitToUser(collector_id, "broadcast:cleared", { broadcastId: b.id, reason: "expired" });
    }
  }
  if (expired.length) console.log(`[jobs] pin expiry: ${expired.length} broadcast(s) expired`);
}

/** Request timeout (design §3.2): household must never stare at a silent screen. */
async function requestTimeoutSweep() {
  const timeoutSeconds = await getConfigNumber(AppConfigKeys.requestTimeoutSeconds, defaults.requestTimeoutSeconds);
  const rows = await query<{ id: string; household_id: string }>(
    `UPDATE requests SET status = 'timed_out', responded_at = now()
     WHERE status IN ('requested','seen')
       AND requested_at < now() - interval '${timeoutSeconds} seconds'
     RETURNING id, household_id`
  );
  for (const r of rows) emitToUser(r.household_id, "request:timed_out", { requestId: r.id });
  if (rows.length) console.log(`[jobs] request timeout: ${rows.length} request(s) timed out`);
}

/** Double-blind review release (design §16): reveal together, or once the window closes. */
async function reviewReleaseSweep() {
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
  for (const subjectId of subjects) await recomputeRatingAggregate(subjectId);
  if (released.length) console.log(`[jobs] review release: ${released.length} review(s) made visible`);
}

/**
 * Recomputes one user's rating_avg/rating_count from scratch against currently-visible reviews.
 * `UNIQUE(author_id, request_id)`/`UNIQUE(author_id, broadcast_id)` already guarantee at most
 * one rating per author per interaction, so this can never double-count — but it must be
 * re-run any time a review's visibility changes, not just at release time: an admin removing a
 * previously-visible review (moderation_flags resolve, or a direct remove) changes the same
 * aggregate this function computes, and was previously left stale until the next unrelated
 * release swept past the same subject. Exported so `admin/routes.ts` can call it directly.
 */
export async function recomputeRatingAggregate(userId: string) {
  const agg = await query<{ avg: string | null; count: string; role: string }>(
    `SELECT AVG(rating)::numeric(3,2) AS avg, COUNT(*) AS count, u.role
     FROM reviews r JOIN users u ON u.id = r.subject_id
     WHERE r.subject_id = $1 AND r.status = 'visible'
     GROUP BY u.role`,
    [userId]
  );
  const row = agg[0];
  // No row at all means the subject has zero visible reviews (e.g. their only one was just
  // removed) — still reset to zero rather than leaving a stale avg/count from before.
  const roleRow = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  const role = row?.role ?? roleRow[0]?.role;
  if (!role) return;
  const table = role === "collector" ? "collectors" : "households";
  await query(`UPDATE ${table} SET rating_avg = $1, rating_count = $2 WHERE user_id = $3`, [row?.avg ?? null, row?.count ?? 0, userId]);
}

const sweepHandlers: Record<string, () => Promise<void>> = {
  "presence-sweep": presenceSweep,
  "pin-expiry": pinExpirySweep,
  "request-timeout": requestTimeoutSweep,
  "review-release": reviewReleaseSweep,
};

// ---------------------------------------------------------------- fan-out (design §7)

interface FanoutJobData {
  broadcastId: string;
  householdId: string;
  lon: number;
  lat: number;
  wasteType: string | null;
  note: string | null;
  householdName: string | null;
  householdPhone: string;
  radiusM: number;
}

async function processFanout(job: Job<FanoutJobData>) {
  const { broadcastId, householdId, lon, lat, wasteType, note, householdName, householdPhone, radiusM } = job.data;
  // pins:active is registered synchronously in the route handler (broadcasts/routes.ts) so a
  // collector's very next poll sees the pin even before this job gets a worker slot.

  const candidates = await nearbyCollectors(lon, lat, radiusM);
  if (candidates.length === 0) {
    emitToUser(householdId, "broadcast:fanned_out", { broadcastId, notified: 0 });
    return { notified: 0 };
  }

  const rows = await query<{ user_id: string; waste_types: string[]; quiet_hours: { start: string; end: string } | null }>(
    `SELECT c.user_id, c.waste_types, c.quiet_hours
     FROM collectors c JOIN users u ON u.id = c.user_id
     WHERE u.suspended = false AND c.user_id = ANY($1)`,
    [candidates.map((c) => c.id)]
  );
  const profileById = new Map(rows.map((r) => [r.user_id, r]));

  const notifCap = await getConfigNumber(AppConfigKeys.notifCapPer10Min, defaults.notifCapPer10Min);
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

  let notified = 0;
  for (const candidate of candidates) {
    const profile = profileById.get(candidate.id);
    if (!profile) continue; // suspended, or dropped from Postgres since the geo write
    if (wasteType && profile.waste_types?.length && !profile.waste_types.includes(wasteType)) continue;
    if (profile.quiet_hours && inQuietHours(nowMinutes, profile.quiet_hours)) continue;
    if (!(await checkNotifRateLimit(candidate.id, notifCap))) continue; // alert-fatigue gauntlet (§7)

    await query(
      `INSERT INTO broadcast_notifications (broadcast_id, collector_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [broadcastId, candidate.id]
    );
    emitToUser(candidate.id, "broadcast:new", {
      broadcastId,
      lon,
      lat,
      wasteType,
      note,
      householdName,
      householdPhone,
    });
    notified++;
  }
  emitToUser(householdId, "broadcast:fanned_out", { broadcastId, notified });
  return { notified };
}

// ---------------------------------------------------------------- moderation (design §18.1)

interface ModerateJobData {
  targetType: "review" | "reply";
  targetId: string;
  text: string;
}

async function processModerate(job: Job<ModerateJobData>) {
  const { targetType, targetId, text } = job.data;
  const verdict = await classifyText(text || "(no comment, rating only)", targetType === "review" ? "review comment" : "review reply");
  if (!verdict) return { verdict: "no-key-or-error" }; // fails closed — stays pending for the admin queue

  const table = targetType === "review" ? "reviews" : "review_replies";
  if (verdict.verdict === "allow") {
    if (targetType === "reply") {
      await query(`UPDATE review_replies SET moderation_passed = true, status = 'visible' WHERE id = $1`, [targetId]);
    } else {
      await query(`UPDATE reviews SET moderation_passed = true WHERE id = $1`, [targetId]);
    }
  } else {
    await query(`UPDATE ${table} SET status = 'flagged' WHERE id = $1`, [targetId]);
    await query(
      `INSERT INTO moderation_flags (target_type, target_id, reason, source, score) VALUES ($1, $2, $3, 'ai', $4)`,
      [targetType, targetId, verdict.categories.join(",") || verdict.reason || "flagged", verdict.confidence]
    );
  }
  return { verdict: verdict.verdict };
}

// ---------------------------------------------------------------- wiring

let workers: Worker[] = [];

export function startWorkers() {
  // Each Worker gets its own duplicated connection — BullMQ Workers use blocking Redis commands
  // to wait for jobs, and sharing one connection across multiple Workers can starve them.
  const sweeps = new Worker(
    "sweeps",
    async (job) => {
      const handler = sweepHandlers[job.name];
      if (!handler) throw new Error(`Unknown sweep job: ${job.name}`);
      await handler();
    },
    { connection: connection.duplicate(), concurrency: 1 }
  );

  const fanout = new Worker("fanout", processFanout, { connection: connection.duplicate(), concurrency: 5 });
  const moderate = new Worker("moderate", processModerate, { connection: connection.duplicate(), concurrency: 3 });

  for (const w of [sweeps, fanout, moderate]) {
    w.on("failed", (job, err) => console.error(`[jobs] ${job?.queueName}:${job?.name} failed`, err.message));
  }

  workers = [sweeps, fanout, moderate];
  console.log("[jobs] BullMQ workers started: sweeps, fanout, moderate");
}

export async function closeWorkers() {
  await Promise.allSettled(workers.map((w) => w.close()));
}
