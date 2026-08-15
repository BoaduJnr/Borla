import { config } from "../config.js";
import { moderateQueue } from "../jobs/queues.js";
import { withTimeout } from "../utils/withTimeout.js";

/**
 * AI moderation (borla-technical-design.md §18.1, Job A). Runs at content-creation time, never
 * on the matching hot path. A single structured-output call to Gemini classifies abuse,
 * harassment, spam, and PII leakage. Fails CLOSED: if the key is missing or the call errors or
 * times out, the content stays hidden and lands in the admin's manual-only queue instead of
 * auto-publishing (Technical_Debt_Plan.md, TD-01 covers the no-key path explicitly).
 *
 * The actual classify-and-apply-verdict work now runs inside a BullMQ job (server/src/jobs/
 * workers.ts, `moderate` queue) instead of a bare fire-and-forget async IIFE — this resolves
 * the job-queue half of Technical_Debt_Plan.md TD-05: a slow/failed Gemini call now retries
 * with backoff and survives a worker restart mid-call, rather than silently vanishing.
 */

export type ModerationVerdict = {
  verdict: "allow" | "flag" | "block";
  categories: string[];
  piiFound: boolean;
  confidence: number;
  reason: string;
};

// Google deprecates/gates Gemini model IDs per-account faster than this app redeploys (D-08:
// gemini-2.5-flash 404'd as "no longer available to new users" the moment a fresh key was
// provisioned; the "-latest" alias didn't resolve either). Rather than gamble on one hardcoded
// ID again, try a short list of current candidates in order and remember whichever one actually
// works for this process's key, so a future deprecation degrades to "try the next one" instead
// of silently falling back to the manual queue for every single review.
const MODEL_CANDIDATES = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-latest"];
const TIMEOUT_MS = 8000;

let workingModel: string | null = null; // cached once a candidate succeeds, for this process

export async function classifyText(text: string, context: string): Promise<ModerationVerdict | null> {
  if (!config.geminiApiKey) return null; // no-key path: caller falls back to manual queue

  const prompt = `You are a content moderation classifier for a peer-to-peer waste-collection
marketplace app in Ghana. Classify the following user-submitted ${context} for: abuse,
harassment, spam, and PII leakage (phone numbers, home addresses, full names of third parties).
Respond ONLY with strict JSON matching this shape:
{"verdict":"allow|flag|block","categories":["abuse"|"harassment"|"spam"|"pii"],"piiFound":boolean,"confidence":0.0-1.0,"reason":"short explanation"}

Text to classify:
"""
${text.slice(0, 2000)}
"""`;

  const candidates = workingModel ? [workingModel, ...MODEL_CANDIDATES.filter((m) => m !== workingModel)] : MODEL_CANDIDATES;

  for (const model of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0 },
          }),
        }
      );
      if (!resp.ok) {
        console.error("[moderation] Gemini HTTP error", model, resp.status, await resp.text());
        continue; // try the next candidate — likely a model-availability issue, not a content issue
      }
      const data = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (!["allow", "flag", "block"].includes(parsed.verdict)) continue;
      workingModel = model; // remember it — skip the deprecated ones on every subsequent call
      return {
        verdict: parsed.verdict,
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        piiFound: Boolean(parsed.piiFound),
        confidence: Number(parsed.confidence) || 0,
        reason: String(parsed.reason ?? ""),
      };
    } catch (err) {
      console.error("[moderation] Gemini call failed", model, err);
    } finally {
      clearTimeout(timeout);
    }
  }
  return null; // every candidate failed — fail closed to the manual queue
}

// 5s, not the caller's .catch() alone: moderateQueue.add() uses bullRedis, whose
// maxRetriesPerRequest:null (a real BullMQ requirement, see redis/client.ts) means a call
// against an unreachable Redis retries forever rather than ever rejecting — found live during
// tonight's Upstash quota incident. Both callers already treat a rejection as "logged, not
// fatal" (reviews/routes.ts); this just makes sure a rejection actually happens in bounded time
// instead of hanging the review/reply submission request until the client gives up.
export async function moderateReviewAsync(reviewId: string, text: string) {
  await withTimeout(
    moderateQueue.add("moderate", { targetType: "review", targetId: reviewId, text }),
    5000,
    "moderateQueue.add(review)"
  );
}

export async function moderateReplyAsync(replyId: string, text: string) {
  await withTimeout(
    moderateQueue.add("moderate", { targetType: "reply", targetId: replyId, text }),
    5000,
    "moderateQueue.add(reply)"
  );
}
