import crypto from "node:crypto";

/**
 * Share-link tokens for "Route me" (route_shares). Unlike utils/otp.ts's hashOtp, this
 * deliberately does NOT use bcrypt: bcrypt's slow hashing exists to resist brute-forcing a
 * low-entropy 6-digit code, but this token is a 24-byte random value embedded directly in the
 * URL — already far too high-entropy to brute force, so a fast, unsalted hash is the standard
 * (and correct) choice here, and avoids adding bcrypt's per-call latency to every link open.
 */

export function generateShareToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashShareToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
