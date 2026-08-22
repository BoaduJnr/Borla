import { Worker, type Job } from "bullmq";
import { bullRedis } from "../redis/client.js";
import { query, queryOne } from "../db/pool.js";
import { emitToUser } from "../realtime/socket.js";
import { notifyUser } from "../notify.js";
import { getConfigNumber, AppConfigKeys, defaults } from "../utils/appConfig.js";
import { sweepStalePresence, pinCleared, nearbyCollectorsMerged } from "../redis/presence.js";
import { checkNotifRateLimit } from "../redis/rateLimit.js";
import { inQuietHours } from "../utils/quietHours.js";
import { classifyText } from "../ai/moderation.js";
import { config } from "../config.js";

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
  const expired = await query<{ id: string; household_id: string }>(
    `UPDATE broadcasts SET status = 'expired', resolved_at = now()
     WHERE status = 'active' AND expires_at < now()
     RETURNING id, household_id`
  );
  for (const b of expired) {
    await pinCleared(b.id);
    const notified = await query<{ collector_id: string }>(
      `SELECT collector_id FROM broadcast_notifications WHERE broadcast_id = $1`,
      [b.id]
    );
    for (const { collector_id } of notified) {
      notifyUser(collector_id, "broadcast:cleared", { broadcastId: b.id, reason: "expired" }, {
        title: "Pin no longer available",
        body: "That waste pin expired — no need to head over.",
        tag: `broadcast:${b.id}`,
      });
    }
    // The household itself previously had no push signal for its own pin expiring — only the
    // notified collectors got one — so HouseholdHome relied entirely on an 8s poll (loadActiveBroadcast)
    // to notice the disappearance and prompt "did someone come?". Emitting here lets that poll
    // become a safety net instead of the only path, matching the collector side's broadcast:cleared.
    notifyUser(b.household_id, "broadcast:expired", { broadcastId: b.id }, {
      title: "Your pin expired",
      body: "Did someone come for your waste? Open Borla to let us know.",
      tag: `broadcast:${b.id}`,
    });
  }
  if (expired.length) console.log(`[jobs] pin expiry: ${expired.length} broadcast(s) expired`);
}

/** Request timeout (design §3.2): household must never stare at a silent screen. */
async function requestTimeoutSweep() {
  const timeoutSeconds = await getConfigNumber(AppConfigKeys.requestTimeoutSeconds, defaults.requestTimeoutSeconds);
  const rows = await query<{ id: string; household_id: string }>(
    `UPDATE requests SET status = 'timed_out', responded_at = now(), resolved_at = now()
     WHERE status IN ('requested','seen')
       AND requested_at < now() - interval '${timeoutSeconds} seconds'
     RETURNING id, household_id`
  );
  for (const r of rows) {
    notifyUser(r.household_id, "request:timed_out", { requestId: r.id }, {
      title: "No response",
      body: "That collector didn't respond in time — try another one nearby.",
      tag: `request:${r.id}`,
    });
  }
  if (rows.length) console.log(`[jobs] request timeout: ${rows.length} request(s) timed out`);
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
};

// ---------------------------------------------------------------- fan-out (design §7)

export interface FanoutJobData {
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

/**
 * The actual match-and-notify work, factored out of the BullMQ job handler so
 * broadcasts/routes.ts can also call it directly, inline, as a fallback for exactly the failure
 * mode found live: `fanoutQueue.add()` itself silently failing/timing out under the same Redis
 * instability this incident has been about, meaning the job never gets created at all — no
 * amount of retry/fallback *inside* processFanout helps if processFanout is never invoked in
 * the first place. Normal operation is unaffected: this only runs a second time, inline, if the
 * queue genuinely couldn't take the job.
 */
export async function runFanoutLogic(data: FanoutJobData) {
  const { broadcastId, householdId, lon, lat, wasteType, note, householdName, householdPhone, radiusM } = data;
  // pins:active is registered synchronously in the route handler (broadcasts/routes.ts) so a
  // collector's very next poll sees the pin even before this job gets a worker slot.

  // Merges Redis's GEOSEARCH with a direct Postgres geo query rather than trusting Redis alone
  // — found live that a silently-incomplete Redis write (under Upstash quota pressure) let
  // GEOSEARCH cleanly return zero candidates with no error at all, which meant zero broadcast
  // notifications ever went out even though real online collectors existed nearby in Postgres.
  const candidates = await nearbyCollectorsMerged(lon, lat, radiusM);
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
    notifyUser(
      candidate.id,
      "broadcast:new",
      { broadcastId, lon, lat, wasteType, note, householdName, householdPhone },
      {
        // The core gap this whole feature exists to close: a collector with the tab closed or
        // the phone locked previously got nothing at all for a new pin nearby.
        title: "New waste pickup nearby",
        body: `${householdName ?? "A household"} nearby has ${wasteType ?? "waste"} ready for pickup.`,
        tag: `broadcast:${broadcastId}`,
      }
    );
    notified++;
  }
  emitToUser(householdId, "broadcast:fanned_out", { broadcastId, notified });
  return { notified };
}

async function processFanout(job: Job<FanoutJobData>) {
  return runFanoutLogic(job.data);
}

// ---------------------------------------------------------------- moderation (design §18.1)

interface ModerateJobData {
  targetType: "review" | "reply";
  targetId: string;
  text: string;
}

/**
 * Notifies the *subject* (never the author — they already know they just submitted it) once a
 * review actually becomes visible. Self-contained (looks everything up from just the id) so it
 * can be called identically from every path that can grant visibility: the AI "allow" verdict
 * below, and admin/routes.ts's flag-resolve and manual-approve endpoints — before this, only the
 * AI path existed at all, so a household/collector never learned about a review or reply through
 * any channel, in-app or push.
 */
export async function notifyReviewVisible(reviewId: string) {
  const row = await queryOne<{
    subject_id: string;
    rating: number;
    request_id: string | null;
    broadcast_id: string | null;
    author_name: string | null;
  }>(
    `SELECT r.subject_id, r.rating, r.request_id, r.broadcast_id, u.display_name AS author_name
     FROM reviews r JOIN users u ON u.id = r.author_id
     WHERE r.id = $1`,
    [reviewId]
  );
  if (!row) return;
  notifyUser(
    row.subject_id,
    "review:new",
    { reviewId, requestId: row.request_id, broadcastId: row.broadcast_id, rating: row.rating },
    { title: "New review", body: `${row.author_name ?? "Someone"} rated you ${row.rating}★`, tag: `review:${reviewId}` }
  );
}

/**
 * Notifies whichever of the review's two participants did *not* just write this reply — the
 * thread is a shared, back-and-forth conversation (Technical_Debt_Plan.md: no more double-blind
 * gate), so "the other party" isn't fixed to either the review's author or its subject.
 */
export async function notifyReplyVisible(replyId: string) {
  const row = await queryOne<{
    review_id: string;
    reply_author_id: string;
    review_author_id: string;
    subject_id: string;
    request_id: string | null;
    broadcast_id: string | null;
    reply_author_name: string | null;
  }>(
    `SELECT rr.review_id, rr.author_id AS reply_author_id, r.author_id AS review_author_id, r.subject_id,
            r.request_id, r.broadcast_id, u.display_name AS reply_author_name
     FROM review_replies rr
     JOIN reviews r ON r.id = rr.review_id
     JOIN users u ON u.id = rr.author_id
     WHERE rr.id = $1`,
    [replyId]
  );
  if (!row) return;
  const otherParty = row.reply_author_id === row.review_author_id ? row.subject_id : row.review_author_id;
  notifyUser(
    otherParty,
    "reply:new",
    { replyId, reviewId: row.review_id, requestId: row.request_id, broadcastId: row.broadcast_id },
    { title: "New reply", body: `${row.reply_author_name ?? "Someone"} replied in your conversation`, tag: `review:${row.review_id}` }
  );
}

/**
 * Both a review (a request's chat thread opens with one) and a reply (any later message in
 * that thread, from either party) go visible the moment they individually clear moderation —
 * there is no more double-blind "wait for the other side" gate. That gate used to mean the two
 * participants in the same request could see different things on the same request card
 * depending on who had reviewed whom; removing it is a deliberate trade-off (documented in
 * Technical_Debt_Plan.md) in favour of both sides always seeing one identical, shared thread.
 */
async function processModerate(job: Job<ModerateJobData>) {
  const { targetType, targetId, text } = job.data;
  if (!config.geminiApiKey) return { verdict: "no-key" }; // deliberate, permanent state — retrying achieves nothing, stays in the manual queue

  const verdict = await classifyText(text || "(no comment, rating only)", targetType === "review" ? "review comment" : "review reply");
  if (!verdict) {
    // A key IS configured, so a null verdict here means the call itself failed (network blip,
    // Gemini hiccup, every candidate model erroring) — worth retrying. Throwing lets BullMQ's
    // own attempts/backoff (queues.ts: 3 attempts, exponential) actually engage, instead of the
    // job quietly "succeeding" as a no-op and leaving the item stuck in the manual queue forever
    // after one transient failure that a retry a few seconds later would likely have cleared.
    throw new Error(`Gemini classification failed for ${targetType} ${targetId}`);
  }

  const table = targetType === "review" ? "reviews" : "review_replies";
  if (verdict.verdict === "allow") {
    if (targetType === "review") {
      const row = await queryOne<{ subject_id: string }>(
        `UPDATE reviews SET moderation_passed = true, status = 'visible', visible_at = now() WHERE id = $1 RETURNING subject_id`,
        [targetId]
      );
      if (row) {
        await recomputeRatingAggregate(row.subject_id);
        await notifyReviewVisible(targetId).catch((err) => console.error(`[reviews] failed to notify review ${targetId} visible`, err));
      }
    } else {
      await query(`UPDATE review_replies SET moderation_passed = true, status = 'visible' WHERE id = $1`, [targetId]);
      await notifyReplyVisible(targetId).catch((err) => console.error(`[reviews] failed to notify reply ${targetId} visible`, err));
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
let backoffTimers: ReturnType<typeof setTimeout>[] = [];

// Matches ioredis's ReplyError.message for Upstash's hard monthly command quota (found live —
// see Technical_Debt_Plan.md TD-05 — during the exact incident that motivated this): e.g.
// "ERR max requests limit exceeded. Limit: 500000, Usage: 500010. See https://upstash.com/..."
const REDIS_QUOTA_ERROR_PATTERN = /max requests limit exceeded/i;
const QUOTA_BACKOFF_MS = 60_000;

/** The minimal slice of BullMQ's Worker this needs — kept narrow so it's trivially testable
 *  against a plain fake instead of a real Worker/Redis connection. */
interface BackoffableWorker {
  on(event: "error", listener: (err: Error) => void): unknown;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

/**
 * BullMQ's own internal "wait for the next job" loop has no backoff for a *scripted command*
 * error the way it does for a dropped connection (ioredis's own maxRetriesPerRequest/reconnect
 * strategy already paces those) — an exhausted Upstash monthly quota rejects every single
 * command instantly, so without this the loop re-fires as fast as it possibly can, thousands of
 * times a minute, on the exact free-tier instance that can least afford the added load. Found
 * live: this is the leading suspect for why a hibernating instance's own wake attempt failed
 * during the window the quota ran out. Pausing the worker for QUOTA_BACKOFF_MS and resuming
 * automatically turns an indefinite tight retry loop into a slow, bounded poll instead — no one
 * has to notice the quota ran out and manually restart anything for this part to stop hurting.
 */
export function attachQuotaBackoff(worker: BackoffableWorker, name: string) {
  let backingOff = false;
  worker.on("error", (err) => {
    if (!REDIS_QUOTA_ERROR_PATTERN.test(err.message)) {
      console.error(`[jobs] ${name} worker error:`, err.message);
      return;
    }
    if (backingOff) return; // already pausing/waiting to resume — don't stack timers per error
    backingOff = true;
    console.error(`[jobs] ${name} worker hit the Redis command quota — pausing ${QUOTA_BACKOFF_MS / 1000}s instead of retrying instantly`);
    worker.pause().catch(() => {}); // best-effort: the loop itself stopping matters more than this call succeeding
    const timer = setTimeout(() => {
      backingOff = false;
      worker.resume().catch((e) => console.error(`[jobs] ${name} worker failed to resume after quota backoff`, e));
      console.log(`[jobs] ${name} worker resuming after quota backoff`);
    }, QUOTA_BACKOFF_MS);
    backoffTimers.push(timer);
  });
}

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

  const named: [Worker, string][] = [
    [sweeps, "sweeps"],
    [fanout, "fanout"],
    [moderate, "moderate"],
  ];
  for (const [w, name] of named) {
    w.on("failed", (job, err) => console.error(`[jobs] ${job?.queueName}:${job?.name} failed`, err.message));
    attachQuotaBackoff(w, name);
  }

  workers = [sweeps, fanout, moderate];
  console.log("[jobs] BullMQ workers started: sweeps, fanout, moderate");
}

export async function closeWorkers() {
  for (const t of backoffTimers) clearTimeout(t);
  backoffTimers = [];
  await Promise.allSettled(workers.map((w) => w.close()));
}
