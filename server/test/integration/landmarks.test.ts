import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

const app = createApp();

// No test here calls the real Nominatim API — same stance server/test/unit/sms.test.ts already
// takes with GiantSMS: the live network call itself is accepted as untested, only the logic
// this app controls (validation) is.
describe("GET /landmarks/search", () => {
  it("rejects a query under the 3-character minimum, before ever touching Nominatim", async () => {
    const res = await request(app).get("/api/landmarks/search").query({ q: "ab" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing query", async () => {
    const res = await request(app).get("/api/landmarks/search");
    expect(res.status).toBe(400);
  });
});
