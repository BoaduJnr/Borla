import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import webpush from "web-push";
import { createApp } from "../../src/app.js";
import { query } from "../../src/db/pool.js";
import { config } from "../../src/config.js";
import { signup } from "../helpers.js";
import { sendPushToUser } from "../../src/push/webpush.js";

// Real Postgres for push_subscriptions (same "no mocking the DB" convention as every other test
// in this suite — see redisRateLimit.test.ts's own comment on why). The one thing that genuinely
// can't run for real here is the actual network call to a push service, so only that boundary is
// replaced: vi.spyOn mutates the *same* webpush object this test and src/push/webpush.ts both
// import (Node module caching guarantees one shared instance), which is what actually reaches
// webpush.ts's calls — unlike vi.mock("web-push", ...), which was tried first and, for reasons
// not fully run down, corrupted route registration in *other* test files run in the same process
// (test/integration/push.test.ts started 404ing on routes that don't even touch this module).
// spyOn sidesteps module-graph replacement entirely and never showed that problem.
const app = createApp();

describe("sendPushToUser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Deliberately the FIRST test in this file: sendPushToUser caches "VAPID is configured" in a
  // module-level flag once it sees real keys, so it doesn't call webpush.setVapidDetails on every
  // single send. Blanks config.vapid explicitly (and restores it) rather than assuming server/.env
  // has no keys set — it now does, for real local push testing — so this stays correct regardless
  // of the ambient environment. Ordered before any test below sets config.vapid, so that
  // module-level cache is still empty when this runs.
  it("is a silent no-op when VAPID keys aren't configured (same fail-open pattern as SMS/Gemini)", async () => {
    const { publicKey, privateKey } = config.vapid;
    config.vapid.publicKey = "";
    config.vapid.privateKey = "";
    try {
      const sendSpy = vi.spyOn(webpush, "sendNotification");
      await sendPushToUser("00000000-0000-0000-0000-000000000000", { title: "t", body: "b" });
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      config.vapid.publicKey = publicKey;
      config.vapid.privateKey = privateKey;
    }
  });

  it("sends to every subscription the user has, once VAPID is configured", async () => {
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    config.vapid.subject = "mailto:test@borla.example";
    const setVapidSpy = vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => {});
    const sendSpy = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    const { user, access } = await signup(app, "collector");
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${access}`)
      .send({ endpoint: "https://push.example/1", keys: { p256dh: "p1", auth: "a1" } })
      .expect(201);
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${access}`)
      .send({ endpoint: "https://push.example/2", keys: { p256dh: "p2", auth: "a2" } })
      .expect(201);

    await sendPushToUser(user.id, { title: "New pickup nearby", body: "..." });

    expect(setVapidSpy).toHaveBeenCalledWith("mailto:test@borla.example", "test-public-key", "test-private-key");
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledWith(
      { endpoint: "https://push.example/1", keys: { p256dh: "p1", auth: "a1" } },
      JSON.stringify({ title: "New pickup nearby", body: "..." })
    );
  });

  it("does nothing when the user has no subscriptions", async () => {
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    const sendSpy = vi.spyOn(webpush, "sendNotification");
    await sendPushToUser("00000000-0000-0000-0000-000000000000", { title: "t", body: "b" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("deletes a subscription the push service reports as permanently gone (404/410), but leaves a transient failure alone", async () => {
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => {});

    const { user, access } = await signup(app, "household");
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${access}`)
      .send({ endpoint: "https://push.example/dead", keys: { p256dh: "p1", auth: "a1" } })
      .expect(201);
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${access}`)
      .send({ endpoint: "https://push.example/flaky", keys: { p256dh: "p2", auth: "a2" } })
      .expect(201);

    vi.spyOn(webpush, "sendNotification").mockImplementation(async (sub: any) => {
      const err: any = new Error(sub.endpoint.endsWith("/dead") ? "gone" : "upstream hiccup");
      err.statusCode = sub.endpoint.endsWith("/dead") ? 410 : 500;
      throw err;
    });

    await sendPushToUser(user.id, { title: "t", body: "b" });

    const remaining = await query<{ endpoint: string }>(
      `SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY endpoint`,
      [user.id]
    );
    // The 410 subscription is gone; the 500 one (a transient failure, not this subscription's
    // fault) is left alone for a future send to retry.
    expect(remaining.map((r) => r.endpoint)).toEqual(["https://push.example/flaky"]);
  });

  it("never throws even if every send fails — a push failure must never take the caller down with it", async () => {
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => {});
    vi.spyOn(webpush, "sendNotification").mockRejectedValue(new Error("network blip"));

    const { user, access } = await signup(app, "collector");
    await request(app)
      .post("/api/push/subscribe")
      .set("Authorization", `Bearer ${access}`)
      .send({ endpoint: "https://push.example/flaky2", keys: { p256dh: "p1", auth: "a1" } })
      .expect(201);

    await expect(sendPushToUser(user.id, { title: "t", body: "b" })).resolves.toBeUndefined();
  });
});
