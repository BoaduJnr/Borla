import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signup, auth } from "../helpers.js";
import { query } from "../../src/db/pool.js";

const app = createApp();

describe("push subscriptions (Web Push)", () => {
  it("GET /push/vapid-public-key returns null when VAPID isn't configured (test env default, same as GiantSMS/Gemini)", async () => {
    const res = await request(app).get("/api/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBeNull();
  });

  it("requires auth to subscribe", async () => {
    const res = await request(app)
      .post("/api/push/subscribe")
      .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } });
    expect(res.status).toBe(401);
  });

  it("subscribes an authenticated user, persisting the subscription", async () => {
    const household = await signup(app, "household");
    const endpoint = `https://push.example/${Date.now()}`;
    const res = await request(app)
      .post("/api/push/subscribe")
      .set(auth(household.access))
      .send({ endpoint, keys: { p256dh: "p256dh-value", auth: "auth-value" } });
    expect(res.status).toBe(201);

    const [row] = await query<{ user_id: string; p256dh: string; auth: string }>(
      `SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = $1`,
      [endpoint]
    );
    expect(row.user_id).toBe(household.user.id);
    expect(row.p256dh).toBe("p256dh-value");
    expect(row.auth).toBe("auth-value");
  });

  it("re-subscribing the same endpoint under a different user reassigns it instead of erroring (shared/borrowed device)", async () => {
    const first = await signup(app, "household");
    const second = await signup(app, "collector");
    const endpoint = `https://push.example/shared-${Date.now()}`;

    await request(app)
      .post("/api/push/subscribe")
      .set(auth(first.access))
      .send({ endpoint, keys: { p256dh: "p1", auth: "a1" } })
      .expect(201);
    await request(app)
      .post("/api/push/subscribe")
      .set(auth(second.access))
      .send({ endpoint, keys: { p256dh: "p2", auth: "a2" } })
      .expect(201);

    const rows = await query<{ user_id: string }>(`SELECT user_id FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    expect(rows).toHaveLength(1); // still one row, not a duplicate
    expect(rows[0].user_id).toBe(second.user.id); // reassigned, not left owned by the first user
  });

  it("rejects an invalid endpoint or missing keys", async () => {
    const household = await signup(app, "household");
    const badEndpoint = await request(app)
      .post("/api/push/subscribe")
      .set(auth(household.access))
      .send({ endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } });
    expect(badEndpoint.status).toBe(400);

    const missingKeys = await request(app)
      .post("/api/push/subscribe")
      .set(auth(household.access))
      .send({ endpoint: "https://push.example/x" });
    expect(missingKeys.status).toBe(400);
  });

  it("unsubscribe removes the caller's own subscription", async () => {
    const household = await signup(app, "household");
    const endpoint = `https://push.example/unsub-${Date.now()}`;
    await request(app)
      .post("/api/push/subscribe")
      .set(auth(household.access))
      .send({ endpoint, keys: { p256dh: "p", auth: "a" } })
      .expect(201);

    await request(app).post("/api/push/unsubscribe").set(auth(household.access)).send({ endpoint }).expect(200);

    const rows = await query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    expect(rows).toHaveLength(0);
  });

  it("unsubscribe cannot delete another user's subscription", async () => {
    const owner = await signup(app, "household");
    const stranger = await signup(app, "collector");
    const endpoint = `https://push.example/owned-${Date.now()}`;
    await request(app)
      .post("/api/push/subscribe")
      .set(auth(owner.access))
      .send({ endpoint, keys: { p256dh: "p", auth: "a" } })
      .expect(201);

    await request(app).post("/api/push/unsubscribe").set(auth(stranger.access)).send({ endpoint }).expect(200); // no error either way — but nothing should be deleted

    const rows = await query(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
    expect(rows).toHaveLength(1); // still there — the stranger's request scoped to their own (zero) rows
  });
});
