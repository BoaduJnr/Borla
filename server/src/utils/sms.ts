import { config } from "../config.js";

/**
 * Real SMS delivery via GiantSMS (a Ghanaian bulk-SMS gateway), resolving Technical_Debt_Plan.md
 * TD-02. Best-effort by design: if the token/sender ID aren't configured, or the API call fails
 * for any reason (unfunded account, wrong sender-ID approval, network error), this returns
 * `{ ok: false }` and the caller (auth/routes.ts) falls back to showing the OTP in the app
 * instead of silently locking the user out — a real SMS outage should never be a worse failure
 * mode than "no SMS gateway at all".
 *
 * API shape sourced from the published GiantSMS .NET/PHP client libraries (no first-party
 * OpenAPI spec was available to verify against): POST https://api.giantsms.com/api/v1/send,
 * `Authorization: Basic {token}`, JSON body `{ from, to, msg }`. This has NOT been verified
 * against a funded account — treat as best-effort until a real send is confirmed in production.
 */

const GIANTSMS_BASE_URL = "https://api.giantsms.com/api/v1";
const TIMEOUT_MS = 8000;

export function isSmsConfigured(): boolean {
  return Boolean(config.giantSms.token && config.giantSms.senderId);
}

/** GiantSMS's documented client libraries send Ghanaian numbers in local 0XXXXXXXXX form. */
export function toLocalGhanaFormat(phone: string): string {
  if (phone.startsWith("+233")) return "0" + phone.slice(4);
  if (phone.startsWith("233")) return "0" + phone.slice(3);
  return phone;
}

export async function sendSms(phone: string, message: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSmsConfigured()) return { ok: false, error: "GiantSMS not configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${GIANTSMS_BASE_URL}/send`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${config.giantSms.token}`,
      },
      body: JSON.stringify({
        from: config.giantSms.senderId,
        to: toLocalGhanaFormat(phone),
        msg: message,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("[sms] GiantSMS HTTP error", resp.status, body);
      return { ok: false, error: `GiantSMS HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("[sms] GiantSMS send failed", err);
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
