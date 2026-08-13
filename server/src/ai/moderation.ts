import { query } from "../db/pool.js";
import { config } from "../config.js";

/**
 * AI moderation (borla-technical-design.md §18.1, Job A). Runs at content-creation time, never
 * on the matching hot path. A single structured-output call to Gemini classifies abuse,
 * harassment, spam, and PII leakage. Fails CLOSED: if the key is missing or the call errors or
 * times out, the content stays hidden and lands in the admin's manual-only queue instead of
 * auto-publishing (Technical_Debt_Plan.md, TD-01 covers the no-key path explicitly).
 */

export type ModerationVerdict = {
  verdict: "allow" | "flag" | "block";
  categories: string[];
  piiFound: boolean;
  confidence: number;
  reason: string;
};

const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 8000;

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${config.geminiApiKey}`,
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
      console.error("[moderation] Gemini HTTP error", resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!["allow", "flag", "block"].includes(parsed.verdict)) return null;
    return {
      verdict: parsed.verdict,
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      piiFound: Boolean(parsed.piiFound),
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason ?? ""),
    };
  } catch (err) {
    console.error("[moderation] Gemini call failed", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Fire-and-forget: never awaited by the route handler, so a slow model call can't block the user. */
export function moderateReviewAsync(reviewId: string, text: string) {
  void (async () => {
    const verdict = await classifyText(text || "(no comment, rating only)", "review comment");
    if (!verdict) return; // no key / error — stays pending, visible only via admin manual approval
    if (verdict.verdict === "allow") {
      await query(`UPDATE reviews SET moderation_passed = true WHERE id = $1`, [reviewId]);
    } else {
      await query(`UPDATE reviews SET status = 'flagged' WHERE id = $1`, [reviewId]);
      await query(
        `INSERT INTO moderation_flags (target_type, target_id, reason, source, score)
         VALUES ('review', $1, $2, 'ai', $3)`,
        [reviewId, verdict.categories.join(",") || verdict.reason || "flagged", verdict.confidence]
      );
    }
  })().catch((err) => console.error("[moderation] review pipeline error", err));
}

export function moderateReplyAsync(replyId: string, text: string) {
  void (async () => {
    const verdict = await classifyText(text, "review reply");
    if (!verdict) return;
    if (verdict.verdict === "allow") {
      await query(`UPDATE review_replies SET moderation_passed = true, status = 'visible' WHERE id = $1`, [replyId]);
    } else {
      await query(`UPDATE review_replies SET status = 'flagged' WHERE id = $1`, [replyId]);
      await query(
        `INSERT INTO moderation_flags (target_type, target_id, reason, source, score)
         VALUES ('reply', $1, $2, 'ai', $3)`,
        [replyId, verdict.categories.join(",") || verdict.reason || "flagged", verdict.confidence]
      );
    }
  })().catch((err) => console.error("[moderation] reply pipeline error", err));
}
