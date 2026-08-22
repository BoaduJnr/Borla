import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import webpush from "web-push";
import { createApp } from "../../src/app.js";
import { signup, auth, makeAdmin, waitFor } from "../helpers.js";
import { query } from "../../src/db/pool.js";
import { config } from "../../src/config.js";

/**
 * Exercises the admin manual-approve endpoints rather than the real AI path: GEMINI_API_KEY is
 * configured in this environment, but its free-tier quota is frequently exhausted (seen live —
 * see other test files' Gemini 429 noise), which would make asserting on notification delivery
 * flaky through no fault of the code under test. Manual approve is a real, deterministic path to
 * "this became visible" that exercises the exact same notifyReviewVisible/notifyReplyVisible
 * calls (jobs/workers.ts) the AI "allow" verdict does.
 *
 * notifyUser (server/src/notify.ts) deliberately never awaits the push send — a slow/unreachable
 * push service must never block the HTTP response for the action that triggered it — so the spy
 * call this asserts on can still be in flight the instant the approve request resolves. Polled
 * via the same waitFor() helper already used elsewhere in this suite for BullMQ's own async side
 * effects, rather than asserting immediately after the await.
 */
const app = createApp();
const POINT = { lon: -0.1786, lat: 5.556 };

async function acceptedRequest() {
  const household = await signup(app, "household");
  const collector = await signup(app, "collector");
  await query(`UPDATE users SET verified = true WHERE id = $1`, [collector.user.id]);
  await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...POINT });
  const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
  await request(app).post(`/api/requests/${created.body.request.id}/accept`).set(auth(collector.access));
  return { household, collector, requestId: created.body.request.id as string };
}

async function subscribe(access: string, endpoint: string) {
  await request(app)
    .post("/api/push/subscribe")
    .set(auth(access))
    .send({ endpoint, keys: { p256dh: "p", auth: "a" } })
    .expect(201);
}

describe("push/in-app notifications for reviews and replies", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => {});
    vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });
  });

  it("notifies the subject (never the author) once a review becomes visible via admin approve", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    await subscribe(collector.access, `https://push.example/subject-${Date.now()}`);
    await subscribe(household.access, `https://push.example/author-${Date.now()}`);

    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 4, comment: "Good service" });
    const reviewId = review.body.review.id;

    const admin = await makeAdmin(app);
    await request(app).post(`/api/admin/reviews/${reviewId}/approve`).set(auth(admin.access)).expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1);
    expect(sendSpy).toHaveBeenCalledTimes(1); // only the subject, not the author who submitted it
    const [subscriptionArg, payloadArg] = sendSpy.mock.calls[0];
    expect(subscriptionArg).toMatchObject({ endpoint: expect.stringContaining("subject-") });
    const pushBody = JSON.parse(payloadArg as string);
    expect(pushBody.title).toBe("New review");
    expect(pushBody.body).toContain("4★");
  });

  it("notifies the OTHER party in the thread, not whoever just wrote the reply", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5 });
    const reviewId = review.body.review.id;
    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);

    // Both subscribe fresh, then the collector (the review's *subject*) replies — the household
    // (the original *author*) should be the one notified, proving the "other party" logic isn't
    // hardcoded to always mean "the subject".
    await subscribe(household.access, `https://push.example/household-${Date.now()}`);
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    vi.mocked(webpush.sendNotification).mockClear();

    const reply = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thank you!" });
    const admin = await makeAdmin(app);
    await request(app).post(`/api/admin/replies/${reply.body.reply.id}/approve`).set(auth(admin.access)).expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ endpoint: expect.stringContaining("household-") });
  });

  it("also notifies via flag-resolve (the third path a review can become visible through)", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    await subscribe(collector.access, `https://push.example/flagresolve-${Date.now()}`);

    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 3 });
    const reviewId = review.body.review.id;
    await query(`UPDATE reviews SET status = 'pending' WHERE id = $1`, [reviewId]);
    const flag = await query<{ id: string }>(
      `INSERT INTO moderation_flags (target_type, target_id, reason, source) VALUES ('review', $1, 'test', 'user_report') RETURNING id`,
      [reviewId]
    );

    const admin = await makeAdmin(app);
    await request(app)
      .post(`/api/admin/moderation/flags/${flag[0].id}/resolve`)
      .set(auth(admin.access))
      .send({ action: "clear" })
      .expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
