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

  it("stays hidden until an admin (or AI) clears moderation, then a reply is capped at one", async () => {
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

    // Force it visible directly (equivalent to moderation_passed=true + release sweep having run).
    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);

    const reply1 = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thanks!" });
    expect(reply1.status).toBe(201);

    const reply2 = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Again!" });
    expect(reply2.status).toBe(409); // one public reply per review

    const notSubject = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(household.access)).send({ body: "Sneaky" });
    expect(notSubject.status).toBe(403);
  });

  it("GET /reviews/mine lets the author see their own review regardless of visibility (unlike GET /users/:id/reviews)", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 4, comment: "Good service" });
    const reviewId = review.body.review.id;

    // Author can see it immediately, still pending — this is exactly what's missing from
    // GET /users/:id/reviews (visible-only), which would show nothing at all here.
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

  it("GET /requests/:id/reviews shows the review + reply on the request they belong to, not just in a flat list", async () => {
    const { household, collector, requestId } = await acceptedRequest();
    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5, comment: "Great!" });
    const reviewId = review.body.review.id;

    // Before release: the author sees `mine` regardless of status; the subject sees no `theirs`
    // at all (same reveal-on-visible rule as everywhere else).
    const collectorView = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(collector.access));
    expect(collectorView.body.mine).toBeNull();
    expect(collectorView.body.theirs).toBeNull();

    const householdView = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(household.access));
    expect(householdView.body.mine.id).toBe(reviewId);
    expect(householdView.body.mine.status).toBe("pending");
    expect(householdView.body.theirs).toBeNull(); // no one has reviewed the household back

    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);

    const collectorAfter = await request(app).get(`/api/requests/${requestId}/reviews`).set(auth(collector.access));
    expect(collectorAfter.body.theirs.id).toBe(reviewId);
    expect(collectorAfter.body.theirs.comment).toBe("Great!");
    expect(collectorAfter.body.theirs.reply_body).toBeNull();

    // Someone not part of this request gets a clean 403, not a leak of either side's review.
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
