import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { testPhone, signup, auth } from "../helpers.js";

const app = createApp();

describe("auth: OTP signup/login", () => {
  it("rejects an OTP request for a brand-new number with no role", async () => {
    const res = await request(app).post("/api/auth/otp/request").send({ phone: testPhone() });
    expect(res.status).toBe(400);
  });

  it("issues a devOtp (no real SMS gateway) and completes signup on verify", async () => {
    const phone = testPhone();
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone, role: "household" });
    expect(otpRes.status).toBe(200);
    expect(otpRes.body.devOtp).toMatch(/^\d{6}$/);
    expect(otpRes.body.isNewUser).toBe(true);

    const verifyRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone, code: otpRes.body.devOtp, role: "household", displayName: "Ama" });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.access).toBeTruthy();
    expect(verifyRes.body.user.role).toBe("household");
  });

  it("rejects an incorrect OTP code", async () => {
    const phone = testPhone();
    await request(app).post("/api/auth/otp/request").send({ phone, role: "collector" });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "000000", role: "collector" });
    expect(res.status).toBe(400);
  });

  it("rejects a reused OTP code", async () => {
    const phone = testPhone();
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone, role: "household" });
    const code = otpRes.body.devOtp;
    const first = await request(app).post("/api/auth/otp/verify").send({ phone, code, role: "household" });
    expect(first.status).toBe(200);

    // Re-request a fresh OTP for the same number and try the OLD (already-consumed) code.
    await request(app).post("/api/auth/otp/request").send({ phone });
    const replay = await request(app).post("/api/auth/otp/verify").send({ phone, code });
    expect(replay.status).toBe(400);
  });

  it("GET /auth/me requires a bearer token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("GET /auth/me returns the profile for a valid token", async () => {
    const { access } = await signup(app, "household");
    const res = await request(app).get("/api/auth/me").set(auth(access));
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("household");
    expect(res.body.profile).toHaveProperty("alert_radius_m");
  });

  it("POST /auth/refresh issues a new access token", async () => {
    const { refresh } = await signup(app, "collector");
    const res = await request(app).post("/api/auth/refresh").send({ refresh });
    expect(res.status).toBe(200);
    expect(res.body.access).toBeTruthy();
  });

  it("admin login rejects a non-admin phone", async () => {
    const { phone } = await signup(app, "household");
    const res = await request(app).post("/api/auth/admin/login").send({ phone, password: "whatever" });
    expect(res.status).toBe(401);
  });
});
