import request from "supertest";
import type { Express } from "express";

let counter = 0;

/** Unique test phone number so parallel test files never collide on the users.phone unique constraint. */
export function testPhone(): string {
  counter += 1;
  return `+23399${String(Date.now()).slice(-6)}${String(counter).padStart(2, "0")}`;
}

export async function signup(app: Express, role: "household" | "collector", phone = testPhone()) {
  const otpRes = await request(app).post("/api/auth/otp/request").send({ phone, role });
  const devOtp = otpRes.body.devOtp as string;
  const verifyRes = await request(app)
    .post("/api/auth/otp/verify")
    .send({ phone, code: devOtp, role, displayName: `Test ${role}` });
  return { phone, access: verifyRes.body.access as string, refresh: verifyRes.body.refresh as string, user: verifyRes.body.user };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
