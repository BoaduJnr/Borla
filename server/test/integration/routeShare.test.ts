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

  describe("checkin (admin's 'original location' + the 150m found marker)", () => {
    it("captures the receiver's first-fix location once, and never overwrites it on a later ping", async () => {
      const createRes = await request(app)
        .post("/api/route-share")
        .send({ phone: testPhone(), senderLon: -0.2, senderLat: 5.6 });
      const token = (createRes.body.devLink as string).split("/route/")[1];
      const tokenHash = hashShareToken(token);

      await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.21, lat: 5.61 });
      await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.25, lat: 5.65 }); // moved since

      const [row] = await query<{ receiver_lon: number; receiver_lat: number }>(
        `SELECT receiver_lon, receiver_lat FROM route_shares WHERE token_hash = $1`,
        [tokenHash]
      );
      expect(row.receiver_lon).toBeCloseTo(-0.21); // still the FIRST fix, not the second
      expect(row.receiver_lat).toBeCloseTo(5.61);
    });

    it("marks the link found once the receiver checks in within 150m, and a later check-in doesn't move found_at again", async () => {
      const createRes = await request(app)
        .post("/api/route-share")
        .send({ phone: testPhone(), senderLon: -0.19, senderLat: 5.62 });
      const token = (createRes.body.devLink as string).split("/route/")[1];

      const far = await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.5, lat: 6.0 });
      expect(far.body.found).toBe(false);

      const close = await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.19, lat: 5.62 });
      expect(close.body.found).toBe(true);

      const tokenHash = hashShareToken(token);
      const [afterFirstFound] = await query<{ found_at: string }>(`SELECT found_at FROM route_shares WHERE token_hash = $1`, [tokenHash]);
      expect(afterFirstFound.found_at).toBeTruthy();

      const again = await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.19, lat: 5.62 });
      expect(again.body.found).toBe(true); // already found, still reported true
      const [afterSecond] = await query<{ found_at: string }>(`SELECT found_at FROM route_shares WHERE token_hash = $1`, [tokenHash]);
      // pg returns timestamptz as a Date object, not a string — compare by value (.getTime()),
      // same as auth/routes.ts already does elsewhere for otp_codes.expires_at, not by reference.
      expect(new Date(afterSecond.found_at).getTime()).toBe(new Date(afterFirstFound.found_at).getTime()); // unchanged — not re-stamped
    });

    it("404s for a check-in against a token that doesn't exist", async () => {
      const res = await request(app).post("/api/route-share/this-token-does-not-exist/checkin").send({ lon: 0, lat: 0 });
      expect(res.status).toBe(404);
    });

    it("404s for a check-in against an expired token", async () => {
      const token = "expired-checkin-token";
      await query(
        `INSERT INTO route_shares (token_hash, sender_lon, sender_lat, phone, expires_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
        [hashShareToken(token), -0.19, 5.6, testPhone()]
      );
      const res = await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: -0.19, lat: 5.6 });
      expect(res.status).toBe(404);
    });

    it("rejects out-of-range check-in coordinates", async () => {
      const createRes = await request(app)
        .post("/api/route-share")
        .send({ phone: testPhone(), senderLon: -0.19, senderLat: 5.6 });
      const token = (createRes.body.devLink as string).split("/route/")[1];
      const res = await request(app).post(`/api/route-share/${token}/checkin`).send({ lon: 999, lat: 5.6 });
      expect(res.status).toBe(400);
    });
  });
});
