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
  isTest: process.env.NODE_ENV === "test",
  databaseUrl: required("DATABASE_URL", "postgres://borla:borla@localhost:5432/borla"),
  redisUrl: required("REDIS_URL", "redis://localhost:6380"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  accessTokenTtl: "15m",
  refreshTokenTtl: "30d",
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  giantSms: {
    token: process.env.GIANTSMS_API_TOKEN ?? "",
    senderId: process.env.GIANTSMS_SENDER_ID ?? "",
  },
  // Web Push (VAPID) — real OS-level notifications, closing the gap Socket.IO alone can't:
  // emitToUser() only reaches a client with the tab open and connected right now. Same
  // fail-open-without-a-key spirit as geminiApiKey/giantSms above: notify.ts's push half is a
  // silent no-op whenever these aren't configured, never a hard failure blocking the socket half.
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:admin@borla.example",
  },
  // Business tuning defaults — mirrored in app_config so admins can retune without redeploy
  // (borla-technical-design.md §17 "Neighbourhood & config management")
  defaults: {
    broadcastRadiusM: 1200,
    pinTtlMinutes: 45,
    requestTimeoutSeconds: 90,
    notifCapPer10Min: 10,
    arrivalRadiusM: 40,
  },
};
