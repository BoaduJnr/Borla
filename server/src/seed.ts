import bcrypt from "bcryptjs";
import { pool, query, queryOne } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

/**
 * Seeds demo accounts for grading/UAT, per Deployment_and_Source_Links.txt:
 *   - one admin (phone + password login)
 *   - one household, one collector (both phone+OTP — request an OTP and read the devOtp
 *     returned by the API; these accounts have no fixed password by design, see User_Manual.md)
 * Idempotent: safe to run repeatedly, and called automatically on every server boot
 * (server/src/index.ts) so the graded demo credentials always exist, redeploys included.
 */

// Accra-ish coordinates (Osu) so the two demo accounts are within the default broadcast radius.
// These numbers are arbitrary, not real handsets — real SMS delivery to them would just be
// accepted by the gateway and vanish, locking out anyone grading this without a live phone on
// that exact number. See DEMO_OTP below: these two numbers always get a fixed, well-known code
// instead of a real send, specifically so grading never depends on SMS actually arriving.
export const HOUSEHOLD_PHONE = "+233200000001";
export const COLLECTOR_PHONE = "+233200000002";
export const ADMIN_PHONE = "+233200000000";
export const ADMIN_PASSWORD = "Borla-Admin-2026!";
export const DEMO_OTP = "482913";
export const DEMO_PHONES = [HOUSEHOLD_PHONE, COLLECTOR_PHONE];

async function upsertUser(phone: string, role: string, displayName: string, extra: Record<string, any> = {}) {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [phone]);
  if (existing) return existing.id;
  const user = await queryOne<{ id: string }>(
    `INSERT INTO users (phone, role, display_name, verified, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [phone, role, displayName, extra.verified ?? role !== "collector", extra.passwordHash ?? null]
  );
  return user!.id;
}

export async function seedDemoData() {
  const adminId = await upsertUser(ADMIN_PHONE, "admin", "Ops Admin", {
    verified: true,
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
  });

  const householdId = await upsertUser(HOUSEHOLD_PHONE, "household", "Ama (Osu)");
  await query(
    `INSERT INTO households (user_id, home_lon, home_lat, home_location)
     VALUES ($1, -0.1786, 5.5560, ST_SetSRID(ST_MakePoint(-0.1786, 5.5560), 4326)::geography)
     ON CONFLICT (user_id) DO NOTHING`,
    [householdId]
  );

  const collectorId = await upsertUser(COLLECTOR_PHONE, "collector", "Kwame the Collector", { verified: true });
  await query(
    `INSERT INTO collectors (user_id, vehicle_type, waste_types, online, last_lon, last_lat, last_location, last_seen_at)
     VALUES ($1, 'tricycle', ARRAY['general','recyclable'], true, -0.1800, 5.5570,
             ST_SetSRID(ST_MakePoint(-0.1800, 5.5570), 4326)::geography, now())
     ON CONFLICT (user_id) DO UPDATE SET online = true, last_seen_at = now()`,
    [collectorId]
  );
  // Collectors also need `users.verified = true` to go online — set explicitly for the demo account.
  await query(`UPDATE users SET verified = true WHERE id = $1`, [collectorId]);

  return { adminId, householdId, collectorId };
}

// CLI entrypoint for `npm run seed -w server` — not used by the server's own boot path, which
// calls seedDemoData() directly (see index.ts).
async function main() {
  await runMigrations();
  const { adminId, householdId, collectorId } = await seedDemoData();

  console.log(`\nSeed complete. admin=${adminId} household=${householdId} collector=${collectorId}\n`);
  console.log("Admin login   : POST /api/auth/admin/login");
  console.log(`  phone: ${ADMIN_PHONE}  password: ${ADMIN_PASSWORD}`);
  console.log(`\nHousehold demo: phone ${HOUSEHOLD_PHONE}, fixed OTP ${DEMO_OTP}`);
  console.log(`Collector demo: phone ${COLLECTOR_PHONE}, fixed OTP ${DEMO_OTP}`);
  console.log("(Both demo numbers always use this fixed code — no SMS is ever sent to them, since\n" +
    " they're arbitrary numbers, not real handsets. Any other phone gets a real/random OTP.)\n");

  await pool.end();
}

const isMain = process.argv[1]?.endsWith("seed.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
