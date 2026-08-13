import bcrypt from "bcryptjs";

/**
 * OTP generation/verification. There is no SMS gateway wired up in this build (Technical Debt
 * Plan, item TD-02) — the code is hashed at rest like a real credential, but the caller is
 * expected to surface the plaintext code back to the client/UI instead of texting it out.
 */

export function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits, 100000-999999
}

export async function hashOtp(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export async function verifyOtp(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
