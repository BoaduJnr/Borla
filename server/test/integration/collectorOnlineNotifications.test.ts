import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import request from "supertest";
import webpush from "web-push";
import { createApp } from "../../src/app.js";
import { signup, auth, waitFor } from "../helpers.js";
import { query } from "../../src/db/pool.js";
import { config } from "../../src/config.js";

/**
 * Two independent things a collector going online can now trigger that broadcast-creation-time
 * fan-out (jobs/workers.ts runFanoutLogic) never covers, since that only matches against
 * collectors who were *already* online: (1) this collector catching up on a pin they missed
 * while offline, gated by the *admin's* broadcast_radius_m; (2) the household itself hearing
 * "a collector is nearby" for the first time ever, gated by *their own* alert_radius_m — a
 * separate, per-household setting nothing previously consumed at all.
 *
 * Every subscribe() happens before the one /presence call meant to trigger a notification in
 * each test — the collector side's dedup (broadcast_notifications) is permanent per (broadcast,
 * collector) pair regardless of whether a push subscription existed yet when it was first
 * recorded, matching the original creation-time fan-out's own semantics (the socket half already
 * "notifies" them the moment it fires, whether or not push is set up on that device).
 *
 * Each test gets its own randomly-jittered base point, well outside any radius used anywhere in
 * this suite, rather than sharing one fixed coordinate the way most other test files do — this
 * feature is the first to run a genuine proximity *scan* (every other test only ever checks a
 * specific id it already has), and this repo's tests don't truncate Postgres between runs, so a
 * shared fixed point accumulates every active broadcast any earlier test or run ever left behind
 * at it (found live writing these: a later test's spy call list contained other tests' household
 * subscriptions from a completely separate earlier `vitest run` invocation, minutes apart).
 */
const app = createApp();

function uniqueBase() {
  // ~0-220km of jitter in both directions — comfortably larger than the largest radius used
  // anywhere in this suite (2000m), so no previous test's or run's leftover data can ever fall
  // within range of this test's own point.
  return { lon: -0.1786 + (Math.random() - 0.5) * 4, lat: 5.556 + (Math.random() - 0.5) * 4 };
}

/** Offsets latitude by roughly `meters` north of `base` — 1 degree latitude is ~111,320m;
 *  accurate enough for these tests, which only need to land clearly inside/outside a given
 *  radius, not to the metre. */
function north(base: { lon: number; lat: number }, meters: number) {
  return { lon: base.lon, lat: base.lat + meters / 111_320 };
}

async function setBroadcastRadius(meters: number) {
  await query(`UPDATE app_config SET value = $1::jsonb WHERE key = 'broadcast_radius_m'`, [String(meters)]);
}

async function subscribe(access: string, endpoint: string) {
  await request(app)
    .post("/api/push/subscribe")
    .set(auth(access))
    .send({ endpoint, keys: { p256dh: "p", auth: "a" } })
    .expect(201);
}

async function verifiedCollector() {
  const collector = await signup(app, "collector");
  await query(`UPDATE users SET verified = true WHERE id = $1`, [collector.user.id]);
  return collector;
}

describe("a collector going online notifies both sides for anything the creation-time fan-out missed", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    config.vapid.publicKey = "test-public-key";
    config.vapid.privateKey = "test-private-key";
    vi.spyOn(webpush, "setVapidDetails").mockImplementation(() => {});
    vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await setBroadcastRadius(1000);
  });

  // app_config is genuinely global, shared with every other test file run in the same process —
  // one test here sets broadcast_radius_m to 500, and without this it would stay at 500 for
  // whatever test file happens to run after this one, silently breaking any test relying on the
  // real seeded default (1200m). Restored once, after every test in this file has finished.
  afterAll(async () => {
    await setBroadcastRadius(1200);
  });

  it("notifies both the collector (admin radius) and the household (their own radius) when both are in range", async () => {
    const base = uniqueBase();
    const household = await signup(app, "household");
    await request(app).patch("/api/households/me").set(auth(household.access)).send({ alertRadiusM: 300, alertsEnabled: true });
    await request(app).post("/api/broadcasts").set(auth(household.access)).send(base).expect(201);
    await subscribe(household.access, `https://push.example/household-${Date.now()}`);

    const collector = await verifiedCollector();
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    await request(app)
      .post("/api/presence")
      .set(auth(collector.access))
      .send({ online: true, ...north(base, 200) }) // inside both the 300m household radius and 1000m admin radius
      .expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 2);
    const endpoints = sendSpy.mock.calls.map((c) => (c[0] as any).endpoint);
    expect(endpoints.some((e) => e.includes("household-"))).toBe(true);
    expect(endpoints.some((e) => e.includes("collector-"))).toBe(true);
  });

  it("notifies only the collector when outside the household's own (smaller) radius but inside the admin radius", async () => {
    const base = uniqueBase();
    const household = await signup(app, "household");
    await request(app).patch("/api/households/me").set(auth(household.access)).send({ alertRadiusM: 300, alertsEnabled: true });
    await request(app).post("/api/broadcasts").set(auth(household.access)).send(base).expect(201);
    await subscribe(household.access, `https://push.example/household-${Date.now()}`);

    const collector = await verifiedCollector();
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    await request(app)
      .post("/api/presence")
      .set(auth(collector.access))
      .send({ online: true, ...north(base, 700) }) // outside 300m household radius, inside 1000m admin radius
      .expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 200)); // let anything else in flight settle before asserting an absence
    const endpoints = sendSpy.mock.calls.map((c) => (c[0] as any).endpoint);
    expect(endpoints.some((e) => e.includes("collector-"))).toBe(true);
    expect(endpoints.some((e) => e.includes("household-"))).toBe(false);
  });

  it("notifies only the household when inside their own (larger) radius but outside the admin radius", async () => {
    const base = uniqueBase();
    await setBroadcastRadius(500); // admin radius: 500m
    const household = await signup(app, "household");
    await request(app).patch("/api/households/me").set(auth(household.access)).send({ alertRadiusM: 2000, alertsEnabled: true });
    await request(app).post("/api/broadcasts").set(auth(household.access)).send(base).expect(201);
    await subscribe(household.access, `https://push.example/household-${Date.now()}`);

    const collector = await verifiedCollector();
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    await request(app)
      .post("/api/presence")
      .set(auth(collector.access))
      .send({ online: true, ...north(base, 800) }) // outside 500m admin radius, inside 2000m household radius
      .expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    const endpoints = sendSpy.mock.calls.map((c) => (c[0] as any).endpoint);
    expect(endpoints.some((e) => e.includes("household-"))).toBe(true);
    expect(endpoints.some((e) => e.includes("collector-"))).toBe(false);
  });

  it("never notifies a household that has alerts turned off, even well within their own radius", async () => {
    const base = uniqueBase();
    const household = await signup(app, "household");
    await request(app).patch("/api/households/me").set(auth(household.access)).send({ alertRadiusM: 2000, alertsEnabled: false });
    await request(app).post("/api/broadcasts").set(auth(household.access)).send(base).expect(201);
    await subscribe(household.access, `https://push.example/household-${Date.now()}`);

    const collector = await verifiedCollector();
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...north(base, 100) }).expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1); // the collector's own notification still lands
    await new Promise((r) => setTimeout(r, 200));
    const endpoints = sendSpy.mock.calls.map((c) => (c[0] as any).endpoint);
    expect(endpoints.some((e) => e.includes("household-"))).toBe(false);
  });

  it("does not re-notify a collector about the same pin twice (dedup via broadcast_notifications)", async () => {
    const base = uniqueBase();
    const household = await signup(app, "household");
    await request(app).patch("/api/households/me").set(auth(household.access)).send({ alertRadiusM: 300, alertsEnabled: true });
    await request(app).post("/api/broadcasts").set(auth(household.access)).send(base).expect(201);

    const collector = await verifiedCollector();
    await subscribe(collector.access, `https://push.example/collector-${Date.now()}`);
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...north(base, 100) }).expect(200);

    const sendSpy = vi.mocked(webpush.sendNotification);
    await waitFor(async () => sendSpy.mock.calls.length >= 1); // the first go-online lands normally

    sendSpy.mockClear();
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: false }).expect(200);
    await request(app).post("/api/presence").set(auth(collector.access)).send({ online: true, ...north(base, 100) }).expect(200);

    await new Promise((r) => setTimeout(r, 300)); // give any (incorrect) resend a moment to have landed
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
