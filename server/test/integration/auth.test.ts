import { describe, it, expect } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { createApp } from "../../src/app.js";
import { testPhone, signup, auth } from "../helpers.js";
import { query } from "../../src/db/pool.js";
import { HOUSEHOLD_PHONE, DEMO_OTP } from "../../src/seed.js";

const app = createApp();

async function makeAdmin() {
  const phone = testPhone();
  await query(`INSERT INTO users (phone, role, display_name, verified, password_hash) VALUES ($1,'admin','Test Admin', true, $2)`, [
    phone,
    await bcrypt.hash("irrelevant", 10),
  ]);
  return phone;
}

describe("auth: OTP signup/login", () => {
  it("issues an OTP for a brand-new number without needing a role upfront (role is collected after verify)", async () => {
    const res = await request(app).post("/api/auth/otp/request").send({ phone: testPhone() });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.requiresPassword).toBe(false);
  });

  it("issues a devOtp (no real SMS gateway) and completes signup on verify, role supplied at verify time", async () => {
    const phone = testPhone();
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone });
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

  it("rejects verify for a new number with no role (role is mandatory once a code is confirmed)", async () => {
    const phone = testPhone();
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: otpRes.body.devOtp });
    expect(res.status).toBe(400);
  });

  it("an existing user verifying just logs straight in — no role/name needed again", async () => {
    const { phone } = await signup(app, "collector");
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone });
    expect(otpRes.body.isNewUser).toBe(false);
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: otpRes.body.devOtp });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("collector");
  });

  it("rejects an incorrect OTP code", async () => {
    const phone = testPhone();
    await request(app).post("/api/auth/otp/request").send({ phone });
    const res = await request(app).post("/api/auth/otp/verify").send({ phone, code: "000000", role: "collector" });
    expect(res.status).toBe(400);
  });

  it("rejects a reused OTP code", async () => {
    const phone = testPhone();
    const otpRes = await request(app).post("/api/auth/otp/request").send({ phone });
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

  it("tells the caller an admin's phone number needs a password instead of issuing an OTP (OTP must never be a second way into an admin account)", async () => {
    const adminPhone = await makeAdmin();
    const res = await request(app).post("/api/auth/otp/request").send({ phone: adminPhone });
    expect(res.status).toBe(200);
    expect(res.body.requiresPassword).toBe(true);
    expect(res.body.devOtp).toBeUndefined();
  });

  it("refuses to verify an OTP into an admin account even if a code somehow exists", async () => {
    const adminPhone = await makeAdmin();
    // Insert a valid OTP row directly, bypassing the (now-fixed) /otp/request guard, to prove
    // /otp/verify itself also refuses admin accounts (defense in depth).
    const code = "123456";
    const hash = await bcrypt.hash(code, 10);
    await query(`INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [
      adminPhone,
      hash,
    ]);
    const res = await request(app).post("/api/auth/otp/verify").send({ phone: adminPhone, code });
    expect(res.status).toBe(400);
  });

  it("the seeded demo household number always gets the fixed DEMO_OTP, never a real SMS attempt, and is exempt from rate limiting", async () => {
    let last;
    for (let i = 0; i < 8; i++) {
      last = await request(app).post("/api/auth/otp/request").send({ phone: HOUSEHOLD_PHONE });
      expect(last.status).toBe(200); // 8 > the normal 5-per-10-min cap, but demo numbers are exempt
    }
    expect(last!.body.requiresPassword).toBe(false);
    expect(last!.body.delivered).toBe(false); // never a real SMS attempt for this number
    expect(last!.body.devOtp).toBe(DEMO_OTP);

    const verify = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: HOUSEHOLD_PHONE, code: DEMO_OTP, role: "household", displayName: "Demo" });
    expect(verify.status).toBe(200);
    expect(verify.body.access).toBeTruthy();
  });
});
