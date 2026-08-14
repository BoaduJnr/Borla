import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signup, auth, makeAdmin } from "../helpers.js";
import { query } from "../../src/db/pool.js";

const app = createApp();
const POINT = { lon: -0.1786, lat: 5.556 };

describe("admin portal (design §17)", () => {
  it("non-admin roles cannot reach /admin/* routes", async () => {
    const { access } = await signup(app, "household");
    const res = await request(app).get("/api/admin/stats").set(auth(access));
    expect(res.status).toBe(403);
  });

  it("verify flips a collector from blocked-to-go-online to allowed, and logs to audit_log", async () => {
    const admin = await makeAdmin(app);
    const collector = await signup(app, "collector");

    const blocked = await request(app)
      .post("/api/presence")
      .set(auth(collector.access))
      .send({ online: true, lon: -0.18, lat: 5.55 });
    expect(blocked.status).toBe(403);

    const verify = await request(app).post(`/api/admin/users/${collector.user.id}/verify`).set(auth(admin.access));
    expect(verify.status).toBe(200);

    const nowAllowed = await request(app)
      .post("/api/presence")
      .set(auth(collector.access))
      .send({ online: true, lon: -0.18, lat: 5.55 });
    expect(nowAllowed.status).toBe(200);

    const auditLog = await request(app).get("/api/admin/audit-log").set(auth(admin.access));
    expect(auditLog.body.auditLog.some((a: any) => a.action === "verify_collector" && a.target_id === collector.user.id)).toBe(true);
  });

  it("suspend blocks login-adjacent access; reinstate restores it", async () => {
    const admin = await makeAdmin(app);
    const household = await signup(app, "household");

    const suspend = await request(app)
      .post(`/api/admin/users/${household.user.id}/suspend`)
      .set(auth(admin.access))
      .send({ reason: "test" });
    expect(suspend.status).toBe(200);

    const blockedMe = await request(app).get("/api/auth/me").set(auth(household.access));
    expect(blockedMe.status).toBe(403);

    const reinstate = await request(app).post(`/api/admin/users/${household.user.id}/reinstate`).set(auth(admin.access));
    expect(reinstate.status).toBe(200);

    const restoredMe = await request(app).get("/api/auth/me").set(auth(household.access));
    expect(restoredMe.status).toBe(200);
  });

  it("config values are live-tunable and rejects unknown keys", async () => {
    const admin = await makeAdmin(app);
    const ok = await request(app).patch("/api/admin/config/pin_ttl_minutes").set(auth(admin.access)).send({ value: 30 });
    expect(ok.status).toBe(200);
    expect(ok.body.config.value).toBe(30);

    const unknown = await request(app).patch("/api/admin/config/not_a_real_key").set(auth(admin.access)).send({ value: 1 });
    expect(unknown.status).toBe(404);

    // restore default so other tests relying on the 45-minute TTL default aren't affected
    await request(app).patch("/api/admin/config/pin_ttl_minutes").set(auth(admin.access)).send({ value: 45 });
  });

  it("D-13: an admin can manually approve a reply stuck awaiting moderation, not just a review", async () => {
    const admin = await makeAdmin(app);
    const household = await signup(app, "household");
    const collector = await signup(app, "collector");
    await query(`UPDATE users SET verified = true WHERE id = $1`, [collector.user.id]);
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...POINT });
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;
    await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));

    const review = await request(app)
      .post("/api/reviews")
      .set(auth(household.access))
      .send({ subjectId: collector.user.id, requestId, rating: 5, comment: "Great!" });
    const reviewId = review.body.review.id;
    await query(`UPDATE reviews SET status = 'visible', moderation_passed = true, visible_at = now() WHERE id = $1`, [reviewId]);

    const reply = await request(app).post(`/api/reviews/${reviewId}/reply`).set(auth(collector.access)).send({ body: "Thanks!" });
    const replyId = reply.body.reply.id;
    // No GEMINI_API_KEY in the test env, so it sits in the manual queue exactly like a review would.
    const queueBefore = await request(app).get("/api/admin/moderation/queue").set(auth(admin.access));
    expect(queueBefore.body.awaitingManual.some((i: any) => i.id === replyId)).toBe(true);

    const approve = await request(app).post(`/api/admin/replies/${replyId}/approve`).set(auth(admin.access));
    expect(approve.status).toBe(200);

    const rows = await query<{ status: string }>(`SELECT status FROM review_replies WHERE id = $1`, [replyId]);
    expect(rows[0].status).toBe("visible");

    const already = await request(app).post(`/api/admin/replies/${replyId}/approve`).set(auth(admin.access));
    expect(already.status).toBe(404); // already resolved, not silently "ok" again
  });
});
