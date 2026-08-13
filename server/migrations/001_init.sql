-- Borla — initial schema
-- Adapted from borla-technical-design.md §4.1, simplified for the web-only v1 build:
--   * standalone `admins` table folded into users.role = 'admin' (documented simplification,
--     see Technical_Debt_Plan.md — no separate 2FA-gated admin auth in this build)
--   * `otp_codes` added because there is no real SMS gateway in this build — the OTP is
--     generated, hashed, and stored here, and shown in the API response / UI instead of texted
--   * `broadcast_notifications` added so a no-winner broadcast pickup can later be attributed
--     to exactly one collector via the "Did they come?" confirmation (needed for review integrity)

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('household','collector','admin')),
  display_name  TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  suspended     BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT,                            -- admins only; household/collector use OTP
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  attempts    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_phone_ix ON otp_codes (phone, created_at DESC);

CREATE TABLE IF NOT EXISTS households (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_lon        DOUBLE PRECISION,
  home_lat        DOUBLE PRECISION,
  home_location   GEOGRAPHY(Point,4326),
  alert_radius_m  INT NOT NULL DEFAULT 800,
  alerts_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  rating_avg      NUMERIC(3,2),
  rating_count    INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collectors (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type   TEXT,
  waste_types    TEXT[] NOT NULL DEFAULT '{}',
  online         BOOLEAN NOT NULL DEFAULT FALSE,
  last_lon       DOUBLE PRECISION,
  last_lat       DOUBLE PRECISION,
  last_location  GEOGRAPHY(Point,4326),
  last_seen_at   TIMESTAMPTZ,
  quiet_hours    JSONB,
  rating_avg     NUMERIC(3,2),
  rating_count   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  UUID NOT NULL REFERENCES users(id),
  lon           DOUBLE PRECISION NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  location      GEOGRAPHY(Point,4326) NOT NULL,
  waste_type    TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cleared','expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS broadcasts_loc_gix ON broadcasts USING GIST (location);
CREATE INDEX IF NOT EXISTS broadcasts_active_ix ON broadcasts (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS broadcast_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  collector_id  UUID NOT NULL REFERENCES users(id),
  notified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, collector_id)
);

CREATE TABLE IF NOT EXISTS requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id          UUID NOT NULL REFERENCES users(id),
  collector_id          UUID NOT NULL REFERENCES users(id),
  lon                   DOUBLE PRECISION NOT NULL,
  lat                   DOUBLE PRECISION NOT NULL,
  location              GEOGRAPHY(Point,4326) NOT NULL,
  waste_type            TEXT,
  note                  TEXT,
  status                TEXT NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested','seen','accepted','rejected','timed_out')),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at          TIMESTAMPTZ,
  contact_revealed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS requests_collector_ix ON requests (collector_id, status);
CREATE INDEX IF NOT EXISTS requests_household_ix ON requests (household_id, status);

CREATE TABLE IF NOT EXISTS pickup_confirmations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  UUID REFERENCES broadcasts(id),
  household_id  UUID NOT NULL REFERENCES users(id),
  collector_id  UUID REFERENCES users(id),
  came          BOOLEAN NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, household_id)
);

-- Two-sided reviews. Every review MUST reference a real interaction (an accepted request,
-- or a confirmed broadcast pickup) — the anti-fraud spine from borla-technical-design.md §16.
CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     UUID NOT NULL REFERENCES users(id),
  subject_id    UUID NOT NULL REFERENCES users(id),
  author_role   TEXT NOT NULL CHECK (author_role IN ('household','collector')),
  request_id    UUID REFERENCES requests(id),
  broadcast_id  UUID REFERENCES broadcasts(id),
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','visible','flagged','removed')),
  moderation_passed BOOLEAN NOT NULL DEFAULT FALSE, -- AI/admin cleared the text; still may await double-blind release
  visible_at    TIMESTAMPTZ,                         -- set when actually released, not a deadline
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (author_id, request_id),
  UNIQUE (author_id, broadcast_id),
  CHECK ((request_id IS NOT NULL) <> (broadcast_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reviews_subject_ix ON reviews (subject_id, status);

CREATE TABLE IF NOT EXISTS review_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   UUID NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author_id   UUID NOT NULL REFERENCES users(id),   -- must equal reviews.subject_id
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','visible','flagged','removed')),
  moderation_passed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id)
);

CREATE TABLE IF NOT EXISTS moderation_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL CHECK (target_type IN ('review','reply')),
  target_id   UUID NOT NULL,
  reason      TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('ai','user_report','admin')),
  score       NUMERIC(4,3),
  resolved    BOOLEAN NOT NULL DEFAULT FALSE,
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_id   UUID,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (key, value) VALUES
  ('broadcast_radius_m', '1200'),
  ('pin_ttl_minutes', '45'),
  ('request_timeout_seconds', '90'),
  ('review_window_days', '7'),
  ('notif_cap_per_10min', '10')
ON CONFLICT (key) DO NOTHING;
