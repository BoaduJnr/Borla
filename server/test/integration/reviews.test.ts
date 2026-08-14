import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signup, auth, makeAdmin } from "../helpers.js";
import { query } from "../../src/db/pool.js";

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

describe("reviews (design §16 — two-sided, tied to real interactions)", () => {
  it("rejects a review on a request that isn't accepted", async () => {
    const household = await signup(app, "household");
    const collector = await signup(app, "collector");
    await query(`UPDATE users SET verified = true WHERE id = $1`, [collector.user.id]);
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...POINT });
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });

    const res = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId: created.body.request.id, rating: 5 });
    expect(res.status).toBe(400);
  });

  it("allows a review on an accepted request and blocks a duplicate", async () => {
    const { household, collector, requestId } = await acceptedRequest();

    const first = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5, comment: "Great!" });
    expect(first.status).toBe(201);
    expect(first.body.review.status).toBe("pending"); // awaiting moderation, even with no comment issues

    const dup = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 1 });
    expect(dup.status).toBe(409);
  });

  it("a third party cannot review a request they weren't part of", async () => {
    const { collector, requestId } = await acceptedRequest();
    const outsider = await signup(app, "household");
    const res = await request(app)
      .post("/api/reviews")
      .set(auth(outsider.access))
      .send({ subjectId: collector.user.id, requestId, rating: 3 });
    expect(res.status).toBe(403);
  });

  it("a review joins the shared thread the moment it clears moderation — no double-blind wait for the other side", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 4, comment: "Good service" });
    const reviewId = review.body.review.id;

    // Not visible yet — no GEMINI_API_KEY in the test env, so it sits in the manual queue.
    const listBefore = await request(app).get(`/api/users/${collector.user.id}/reviews`).set(auth(collector.access));
    expect(listBefore.body.reviews.find((r: any) => r.id === reviewId)).toBeUndefined();

    // A reply attempt before the review is visible is rejected.
    const earlyReply = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thanks!" });
    expect(earlyReply.status).toBe(400);

    // Moderation clears it (equivalent to what processModerate now does directly, no sweep) —
    // it's visible to BOTH sides immediately, not gated on the collector having reviewed back.
    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);
    const bothSee = await request(app).get(`/api/users/${collector.user.id}/reviews`).set(auth(household.access));
    expect(bothSee.body.reviews.find((r: any) => r.id === reviewId)).toBeDefined();

    // Either party can reply now, more than once each — a real chat thread, not "the subject
    // gets exactly one reply".
    const reply1 = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thanks!" });
    expect(reply1.status).toBe(201);

    const reply2 = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(household.access)).send({ body: "You're welcome!" });
    expect(reply2.status).toBe(201);

    const reply3 = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "See you next time." });
    expect(reply3.status).toBe(201);

    const outsider = await signup(app, "household");
    const notAParty = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(outsider.access)).send({ body: "Sneaky" });
    expect(notAParty.status).toBe(403);
  });

  it("GET /reviews/mine lets the author see their own review regardless of visibility", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 4, comment: "Good service" });
    const reviewId = review.body.review.id;

    const mineBefore = await request(app).get("/api/reviews/mine").set(auth(household.access));
    const rowBefore = mineBefore.body.reviews.find((r: any) => r.id === reviewId);
    expect(rowBefore).toBeDefined();
    expect(rowBefore.status).toBe("pending");
    expect(rowBefore.subject_name).toBe(collector.user.display_name);

    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);

    const mineAfter = await request(app).get("/api/reviews/mine").set(auth(household.access));
    expect(mineAfter.body.reviews.find((r: any) => r.id === reviewId).status).toBe("visible");

    // A stranger's "mine" list never contains someone else's authored review.
    const strangerMine = await request(app).get("/api/reviews/mine").set(auth(collector.access));
    expect(strangerMine.body.reviews.find((r: any) => r.id === reviewId)).toBeUndefined();
  });

  it("GET /requests/:id/reviews returns one identical shared thread to both parties, plus each caller's own pending state", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5, comment: "Great!" });
    const reviewId = review.body.review.id;

    // Before moderation clears: neither party's shared `messages` list contains it yet — but
    // the author can still see their own submission is pending via `mine`.
    const collectorBefore = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(collector.access));
    expect(collectorBefore.body.messages).toHaveLength(0);
    expect(collectorBefore.body.mine).toBeNull();
    expect(collectorBefore.body.canReview).toBe(true);

    const householdBefore = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(household.access));
    expect(householdBefore.body.messages).toHaveLength(0);
    expect(householdBefore.body.mine.id).toBe(reviewId);
    expect(householdBefore.body.mine.status).toBe("pending");
    expect(householdBefore.body.canReview).toBe(false); // already reviewed, even though not visible yet

    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);
    await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thanks!" });
    const replyId = (await query<{ id: string }>(`SELECT id FROM review_replies WHERE review_id = $1`, [reviewId]))[0].id;
    await query(`UPDATE review_replies SET status = 'visible', moderation_passed = true WHERE id = $1`, [replyId]);

    // Now BOTH sides see the exact same two-message thread, in order — no asymmetry at all.
    for (const access of [collector.access, household.access]) {
      const view = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(access));
      expect(view.body.messages).toHaveLength(2);
      expect(view.body.messages[0]).toMatchObject({ type: "review", rating: 5, body: "Great!" });
      expect(view.body.messages[1]).toMatchObject({ type: "reply", body: "Thanks!" });
    }

    // Someone not part of this request gets a clean 403, not a leak of the thread.
    const outsider = await signup(app, "household");
    const outsiderAttempt = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(outsider.access));
    expect(outsiderAttempt.status).toBe(403);
  });

  it("removing a previously-visible review recomputes the subject's rating instead of leaving it stale", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5, comment: "Five stars" });
    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [review.body.review.id]);
    await query(`UPDATE collectors SET rating_avg = 5.00, rating_count = 1 WHERE user_id = $1`, [collector.user.id]);

    const admin = await makeAdmin(app);
    const remove = await request(app).post(`/api/admin/reviews/${review.body.review.id}/remove`).set(auth(admin.access));
    expect(remove.status).toBe(200);

    const rows = await query<{ rating_avg: string | null; rating_count: number }>(
      `SELECT rating_avg, rating_count FROM collectors WHERE user_id = $1`,
      [collector.user.id]
    );
    expect(rows[0].rating_count).toBe(0); // not left at the stale count from before removal
    expect(rows[0].rating_avg).toBeNull();
  });
});
