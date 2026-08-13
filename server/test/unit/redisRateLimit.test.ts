import { describe, it, expect } from "vitest";
import { checkNotifRateLimit, checkOtpRateLimit } from "../../src/redis/rateLimit.js";

// Real Redis (server/.env REDIS_URL, pointed at a local instance for tests) — no mocking, per
// the exam's requirement for evidence of real integration testing.

describe("Redis rate limiting (design §7/§4.2, Technical_Debt_Plan.md TD-05)", () => {
  it("allows up to the cap, then blocks the next notification for that collector", async () => {
    const collectorId = `test-collector-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cap = 3;
    for (let i = 0; i < cap; i++) {
      expect(await checkNotifRateLimit(collectorId, cap)).toBe(true);
    }
    expect(await checkNotifRateLimit(collectorId, cap)).toBe(false); // cap+1th call
  });

  it("tracks separate collectors independently", async () => {
    const a = `test-collector-a-${Date.now()}`;
    const b = `test-collector-b-${Date.now()}`;
    expect(await checkNotifRateLimit(a, 1)).toBe(true);
    expect(await checkNotifRateLimit(a, 1)).toBe(false); // a is now capped
    expect(await checkNotifRateLimit(b, 1)).toBe(true); // b is unaffected by a's count
  });

  it("OTP rate limiting allows up to the cap per phone", async () => {
    const phone = `+2339900${Date.now()}`;
    const cap = 5;
    for (let i = 0; i < cap; i++) {
      expect(await checkOtpRateLimit(phone, cap)).toBe(true);
    }
    expect(await checkOtpRateLimit(phone, cap)).toBe(false);
  });
});
