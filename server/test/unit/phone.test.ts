import { describe, it, expect } from "vitest";
import { normalizePhone } from "../../src/utils/phone.js";

/**
 * D-07: "+233200000001", "233200000001", and "0200000001" were three different strings to
 * Postgres, so an already-registered number typed without the leading "+" looked brand new and
 * asked to sign up again instead of logging straight in.
 */
describe("normalizePhone (D-07)", () => {
  it("leaves an already-canonical +233 number unchanged", () => {
    expect(normalizePhone("+233200000001")).toBe("+233200000001");
  });

  it("adds the leading + to a 233-prefixed number with none", () => {
    expect(normalizePhone("233200000001")).toBe("+233200000001");
  });

  it("converts a local 0-prefixed number to +233 form", () => {
    expect(normalizePhone("0200000001")).toBe("+233200000001");
  });

  it("all three forms of the same number normalize identically", () => {
    const forms = ["+233200000001", "233200000001", "0200000001"];
    const normalized = new Set(forms.map(normalizePhone));
    expect(normalized.size).toBe(1);
    expect(normalized.has("+233200000001")).toBe(true);
  });
});
