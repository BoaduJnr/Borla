import { describe, it, expect } from "vitest";
import { toLocalGhanaFormat, isSmsConfigured } from "../../src/utils/sms.js";

describe("sms utils", () => {
  it("normalises +233 and 233 prefixes to local 0XXXXXXXXX form", () => {
    expect(toLocalGhanaFormat("+233200000001")).toBe("0200000001");
    expect(toLocalGhanaFormat("233200000001")).toBe("0200000001");
  });

  it("leaves an already-local number unchanged", () => {
    expect(toLocalGhanaFormat("0200000001")).toBe("0200000001");
  });

  it("reports unconfigured when no token/sender id env vars are set (test env default)", () => {
    expect(isSmsConfigured()).toBe(false);
  });
});
