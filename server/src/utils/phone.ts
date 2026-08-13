/**
 * Normalizes a Ghana-ish phone number to a single canonical E.164-style form ("+233…") before
 * it's ever used as a lookup key or storage value. Without this, "+233200000001",
 * "233200000001", and "0200000001" are three different strings to Postgres — the exact bug
 * that made an already-registered demo number look "brand new" (D-07: a user typed the number
 * without the leading "+" and got asked to sign up again instead of logging straight in).
 */
export function normalizePhone(raw: string): string {
  const digits = raw.trim();
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("233")) return "+" + digits;
  if (digits.startsWith("0")) return "+233" + digits.slice(1);
  return "+" + digits;
}
