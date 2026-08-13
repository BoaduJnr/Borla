import { describe, it, expect } from "vitest";
import { generateOtp, hashOtp, verifyOtp } from "../../src/utils/otp.js";

describe("otp utils", () => {
  it("generates a 6-digit numeric code", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOtp();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("hashes a code and verifies the same code matches", async () => {
    const code = "482913";
    const hash = await hashOtp(code);
    expect(hash).not.toBe(code);
    await expect(verifyOtp(code, hash)).resolves.toBe(true);
  });

  it("rejects an incorrect code against the hash", async () => {
    const hash = await hashOtp("482913");
    await expect(verifyOtp("000000", hash)).resolves.toBe(false);
  });
});
