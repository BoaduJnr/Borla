import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL", "postgres://borla:borla@localhost:5432/borla"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  accessTokenTtl: "15m",
  refreshTokenTtl: "30d",
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  // Business tuning defaults — mirrored in app_config so admins can retune without redeploy
  // (borla-technical-design.md §17 "Neighbourhood & config management")
  defaults: {
    broadcastRadiusM: 1200,
    pinTtlMinutes: 45,
    requestTimeoutSeconds: 90,
    reviewWindowDays: 7,
    notifCapPer10Min: 10,
  },
};
