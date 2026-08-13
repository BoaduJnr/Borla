import { Queue } from "bullmq";
import { bullRedis } from "../redis/client.js";

/**
 * BullMQ queues (borla-technical-design.md §7: "the fan-out is a BullMQ job so a single
 * broadcast can notify many collectors without blocking the request thread, with retries and
 * backoff for push failures"; §18.1: AI jobs "wrapped in a BullMQ job so a slow or failed model
 * call never blocks the user's action"; §6/§3: presence/pin/request/review sweeps as repeatable
 * jobs). Resolves the job-queue half of Technical_Debt_Plan.md TD-05 — replaces the earlier
 * node-cron sweeps and fire-and-forget async IIFEs with a real queue that has retries, backoff,
 * and survives a worker restart mid-job.
 */

const connection = bullRedis;

export const sweepsQueue = new Queue("sweeps", { connection });

export const fanoutQueue = new Queue("fanout", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export const moderateQueue = new Queue("moderate", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});

export async function closeQueues() {
  await Promise.allSettled([sweepsQueue.close(), fanoutQueue.close(), moderateQueue.close()]);
}
