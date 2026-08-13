import request from "supertest";
import type { Express } from "express";
import bcrypt from "bcryptjs";
import { query } from "../src/db/pool.js";

let counter = 0;

/** Unique test phone number so parallel test files never collide on the users.phone unique constraint. */
export function testPhone(): string {
  counter += 1;
  return `+23399${String(Date.now()).slice(-6)}${String(counter).padStart(2, "0")}`;
}

export async function signup(app: Express, role: "household" | "collector", phone = testPhone()) {
  const otpRes = await request(app).post("/api/auth/otp/request").send({ phone });
  const devOtp = otpRes.body.devOtp as string;
  const verifyRes = await request(app)
    .post("/api/auth/otp/verify")
    .send({ phone, code: devOtp, role, displayName: `Test ${role}` });
  return { phone, access: verifyRes.body.access as string, refresh: verifyRes.body.refresh as string, user: verifyRes.body.user };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** A fresh admin account (own random phone, bcrypt-hashed password) — the seeded production
 * admin (Deployment_and_Source_Links.txt) doesn't exist in this isolated test database. */
export async function makeAdmin(app: Express) {
  const phone = testPhone();
  const password = "Test-Admin-Pw-1!";
  await query(`INSERT INTO users (phone, role, display_name, verified, password_hash) VALUES ($1,'admin','Test Admin', true, $2)`, [
    phone,
    await bcrypt.hash(password, 10),
  ]);
  const login = await request(app).post("/api/auth/admin/login").send({ phone, password });
  return { phone, access: login.body.access as string };
}

/**
 * Polls `check` until it returns true or `timeoutMs` elapses — needed because broadcast fan-out
 * and review/reply moderation now run as BullMQ jobs (Technical_Debt_Plan.md TD-05), not
 * synchronously inside the route handler, so their side effects land a beat after the HTTP
 * response.
 */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}
