import { describe, it, expect } from "vitest";
import { inQuietHours } from "../../src/utils/quietHours.js";

const toMin = (h: number, m = 0) => h * 60 + m;

describe("inQuietHours", () => {
  it("is false for a same start/end window (always-on collector)", () => {
    expect(inQuietHours(toMin(3), { start: "22:00", end: "22:00" })).toBe(false);
  });

  it("handles a normal same-day window", () => {
    expect(inQuietHours(toMin(13), { start: "12:00", end: "14:00" })).toBe(true);
    expect(inQuietHours(toMin(15), { start: "12:00", end: "14:00" })).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    const qh = { start: "22:00", end: "05:00" };
    expect(inQuietHours(toMin(23), qh)).toBe(true); // 23:00 — inside
    expect(inQuietHours(toMin(2), qh)).toBe(true); // 02:00 — inside (past midnight)
    expect(inQuietHours(toMin(12), qh)).toBe(false); // noon — outside
  });

  it("boundaries are inclusive at start, exclusive at end", () => {
    const qh = { start: "22:00", end: "05:00" };
    expect(inQuietHours(toMin(22), qh)).toBe(true);
    expect(inQuietHours(toMin(5), qh)).toBe(false);
  });
});
