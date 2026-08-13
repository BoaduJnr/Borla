import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signup, auth } from "../helpers.js";
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
});
