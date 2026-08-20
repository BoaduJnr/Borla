-- Web Push subscriptions (Push API + VAPID) — one row per browser/device a user has opted into
-- notifications on. Closes the gap Socket.IO's emitToUser() alone can't: that only reaches a
-- client with the tab open and connected right now; this reaches the OS notification tray even
-- with the tab closed or the phone locked. A user with multiple devices/browsers gets one row
-- each, all pushed to on every notify() call — see server/src/notify.ts.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_ix ON push_subscriptions (user_id);
