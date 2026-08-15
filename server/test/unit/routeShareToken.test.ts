import { describe, it, expect } from "vitest";
import { generateShareToken, hashShareToken } from "../../src/utils/routeShareToken.js";

describe("route-share tokens", () => {
  it("generates a different token every call", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("hashes the same token identically every time (needed to look it up again by hash)", () => {
    const token = generateShareToken();
    expect(hashShareToken(token)).toBe(hashShareToken(token));
  });

  it("hashes different tokens to different values", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(hashShareToken(a)).not.toBe(hashShareToken(b));
  });

  it("never stores the plaintext token in its own hash", () => {
    const token = generateShareToken();
    expect(hashShareToken(token)).not.toBe(token);
  });
});
