import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signup, auth } from "../helpers.js";
import { query } from "../../src/db/pool.js";

const app = createApp();
const POINT = { lon: -0.1786, lat: 5.556 };

async function verifiedOnlineCollector() {
  const c = await signup(app, "collector");
  await query(`UPDATE users SET verified = true WHERE id = $1`, [c.user.id]);
  await request(app).post("/api/presence").set(auth(c.access)).send({ online: true, ...POINT });
  return c;
}

describe("request plane (design §3.2 state machine)", () => {
  it("cannot request an offline collector", async () => {
    const household = await signup(app, "household");
    const offlineCollector = await signup(app, "collector");
    const res = await request(app)
      .post("/api/requests")
      .set(auth(household.access))
      .send({ collectorId: offlineCollector.user.id, ...POINT });
    expect(res.status).toBe(409);
  });

  it("requested -> seen -> accepted reveals contact only after accept", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();

    const created = await request(app)
      .post("/api/requests")
      .set(auth(household.access))
      .send({ collectorId: collector.user.id, ...POINT });
    expect(created.status).toBe(201);
    const requestId = created.body.request.id;

    const preAccept = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(preAccept.body.request.collector_phone).toBeUndefined();

    const seen = await request(app).post(`/api/requests/${requestId}/seen`).set(auth(collector.access));
    expect(seen.status).toBe(200);

    const accepted = await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));
    expect(accepted.status).toBe(200);

    const postAccept = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(postAccept.body.request.status).toBe("accepted");
    expect(postAccept.body.request.collector_phone).toBe(collector.phone);
  });

  it("a reject after accept is a no-op (idempotent conditional update, design §3.2)", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;

    const accept = await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));
    expect(accept.status).toBe(200);

    // Zero rows affected -> 409 "already resolved", not a silent status flip.
    const rejectAfterAccept = await request(app).post(`/api/requests/${requestId}/reject`).set(auth(collector.access));
    expect(rejectAfterAccept.status).toBe(409);

    const check = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(check.body.request.status).toBe("accepted"); // NOT resurrected to rejected
  });

  it("a stranger collector cannot accept someone else's request", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const stranger = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });

    const res = await request(app).post(`/api/requests/${created.body.request.id}/accept`).set(auth(stranger.access));
    expect(res.status).toBe(409); // conditional update matched zero rows for this collector_id
  });

  it("GET /requests/mine exposes the location each side needs to route to the other, gated the same way as contact reveal", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;

    // Collector already saw the household's pickup point via request:new at creation time —
    // GET /requests/mine reflects that, unconditionally, not gated on acceptance.
    const collectorMineBefore = await request(app).get("/api/requests/mine").set(auth(collector.access));
    const rowBefore = collectorMineBefore.body.requests.find((r: any) => r.id === requestId);
    expect(rowBefore.household_lon).toBeCloseTo(POINT.lon);
    expect(rowBefore.household_lat).toBeCloseTo(POINT.lat);

    // A collector's live position, by contrast, is reveal-on-accept — same timing as the phone
    // number — so the household sees no location before acceptance.
    const householdMineBefore = await request(app).get("/api/requests/mine").set(auth(household.access));
    const hRowBefore = householdMineBefore.body.requests.find((r: any) => r.id === requestId);
    expect(hRowBefore.collector_lon).toBeNull();
    expect(hRowBefore.collector_lat).toBeNull();

    await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));

    const householdMineAfter = await request(app).get("/api/requests/mine").set(auth(household.access));
    const hRowAfter = householdMineAfter.body.requests.find((r: any) => r.id === requestId);
    expect(hRowAfter.collector_lon).toBeCloseTo(POINT.lon);
    expect(hRowAfter.collector_lat).toBeCloseTo(POINT.lat);
  });

  it("a household can cancel its own pending request — something neither accept nor reject covered before", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;

    const cancel = await request(app).post(`/api/requests/${requestId}/cancel`).set(auth(household.access));
    expect(cancel.status).toBe(200);

    const check = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(check.body.request.status).toBe("cancelled");
    expect(check.body.request.cancelled_by).toBe("household");

    // Idempotency guard: already resolved, not a silent no-op success.
    const again = await request(app).post(`/api/requests/${requestId}/cancel`).set(auth(household.access));
    expect(again.status).toBe(409);
  });

  it("a collector can cancel an accepted request; a stranger cannot cancel someone else's", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;
    await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));

    const stranger = await signup(app, "household");
    const strangerAttempt = await request(app).post(`/api/requests/${requestId}/cancel`).set(auth(stranger.access));
    expect(strangerAttempt.status).toBe(409); // not a party to this request — matches zero rows either way

    const cancel = await request(app).post(`/api/requests/${requestId}/cancel`).set(auth(collector.access));
    expect(cancel.status).toBe(200);

    const check = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(check.body.request.status).toBe("cancelled");
    expect(check.body.request.cancelled_by).toBe("collector");
  });

  it("a collector's live position reaching the pickup point marks the request arrived, without a new status", async () => {
    const household = await signup(app, "household");
    const collector = await verifiedOnlineCollector();
    const created = await request(app).post("/api/requests").set(auth(household.access)).send({ collectorId: collector.user.id, ...POINT });
    const requestId = created.body.request.id;
    await request(app).post(`/api/requests/${requestId}/accept`).set(auth(collector.access));

    // A heartbeat reported well outside the arrival radius must NOT mark it arrived.
    const farHeartbeat = await request(app)
      .post("/api/presence/heartbeat")
      .set(auth(collector.access))
      .send({ lon: POINT.lon + 0.05, lat: POINT.lat + 0.05 }); // ~5-7km away
    expect(farHeartbeat.status).toBe(200);
    const stillOnTheWay = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(stillOnTheWay.body.request.arrived_at).toBeNull();
    expect(stillOnTheWay.body.request.status).toBe("accepted");

    // A heartbeat right at the pickup point marks it arrived — status stays 'accepted' (arrival
    // is a fact recorded on the request, not a new terminal status), so review eligibility is
    // untouched.
    const closeHeartbeat = await request(app).post("/api/presence/heartbeat").set(auth(collector.access)).send({ ...POINT });
    expect(closeHeartbeat.status).toBe(200);
    const arrived = await request(app).get(`/api/requests/${requestId}`).set(auth(household.access));
    expect(arrived.body.request.status).toBe("accepted");
    expect(arrived.body.request.arrived_at).not.toBeNull();

    // Once arrived, cancel is no longer offered — there's nothing left to back out of.
    const cancelAfterArrival = await request(app).post(`/api/requests/${requestId}/cancel`).set(auth(household.access));
    expect(cancelAfterArrival.status).toBe(409);
  });
});
