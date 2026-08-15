import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { testPhone } from "../helpers.js";
import { query } from "../../src/db/pool.js";
import { hashShareToken } from "../../src/utils/routeShareToken.js";

const app = createApp();

describe("route-share: 'Route me' SMS link (no login required)", () => {
  it("creates a link, texts nothing in test env (no GiantSMS configured) so returns a devLink instead", async () => {
    const phone = testPhone();
    const res = await request(app).post("/api/route-share").send({ phone, senderLon: -0.187, senderLat: 5.6037 });
    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(false);
    expect(res.body.expiresInMinutes).toBe(30);
    expect(res.body.devLink).toMatch(/\/route\/.+/);
  });

  it("the link's token resolves to the sender's coordinates, never the phone number", async () => {
    const phone = testPhone();
    const createRes = await request(app).post("/api/route-share").send({ phone, senderLon: -0.201, senderLat: 5.61 });
    const token = (createRes.body.devLink as string).split("/route/")[1];

    const fetchRes = await request(app).get(`/api/route-share/${token}`);
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.body.senderLon).toBeCloseTo(-0.201);
    expect(fetchRes.body.senderLat).toBeCloseTo(5.61);
    expect(fetchRes.body.phone).toBeUndefined();
  });

  it("404s for a token that was never issued", async () => {
    const res = await request(app).get("/api/route-share/this-token-does-not-exist");
    expect(res.status).toBe(404);
  });

  it("404s for a token past its expiry, even though the row still exists", async () => {
    const token = "expired-test-token";
    await query(
      `INSERT INTO route_shares (token_hash, sender_lon, sender_lat, phone, expires_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [hashShareToken(token), -0.19, 5.6, testPhone()]
    );
    const res = await request(app).get(`/api/route-share/${token}`);
    expect(res.status).toBe(404);
  });

  it("rejects an invalid phone number before ever touching rate limits or the database", async () => {
    const res = await request(app).post("/api/route-share").send({ phone: "not-a-phone", senderLon: 0, senderLat: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects out-of-range coordinates", async () => {
    const res = await request(app).post("/api/route-share").send({ phone: testPhone(), senderLon: 999, senderLat: 5.6 });
    expect(res.status).toBe(400);
  });
});
