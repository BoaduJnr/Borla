import { queryOne } from "../db/pool.js";
import { config } from "../config.js";

/**
 * Live-tunable settings (borla-technical-design.md §17 "ops can tune the system without a
 * redeploy"). Reads app_config on every call — fine at this scale; a Redis-cached read-through
 * would be the first optimisation if traffic grew (see Technical_Debt_Plan.md).
 */
export async function getConfigNumber(key: string, fallback: number): Promise<number> {
  const row = await queryOne<{ value: any }>(`SELECT value FROM app_config WHERE key = $1`, [key]);
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

export const AppConfigKeys = {
  broadcastRadiusM: "broadcast_radius_m",
  pinTtlMinutes: "pin_ttl_minutes",
  requestTimeoutSeconds: "request_timeout_seconds",
  reviewWindowDays: "review_window_days",
  notifCapPer10Min: "notif_cap_per_10min",
} as const;

export const defaults = config.defaults;
