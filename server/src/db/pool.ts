import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

// Every managed Postgres provider this app has pointed at (Render, Supabase's pooler) requires
// SSL; only a local Docker instance for dev doesn't use it at all. Was previously an allowlist of
// just "render.com" — broke silently the moment DATABASE_URL pointed anywhere else managed
// (found moving to Supabase: its pooler expects TLS and a plain connection just fails to
// connect), so this now assumes SSL unless the host is explicitly local.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
  max: 10,
});

pool.on("error", (err) => {
  // A dropped idle connection must never crash the process.
  console.error("[db] unexpected pool error", err);
});

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
