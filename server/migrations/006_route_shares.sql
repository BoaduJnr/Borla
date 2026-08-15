-- Borla — "Route me" (Option A: SMS a route-share link)
--   Anyone (no login required) can generate a link that texts a phone number; opening the link
--   geolocates the recipient's own browser and shows a route back to the sender's captured
--   position. No sender identity is ever exposed to the recipient (product decision: always
--   anonymous) — this table has no user_id, and the API layer never returns `phone` on read.
--   Modeled directly on otp_codes below: a hashed secret + expires_at, checked at read time.
--   Unlike otp_codes there is no `consumed` flag — links are reusable until they expire (product
--   decision: a recipient may reopen the SMS link a few times while actually walking over).

CREATE TABLE IF NOT EXISTS route_shares (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL,
  sender_lon   DOUBLE PRECISION NOT NULL,
  sender_lat   DOUBLE PRECISION NOT NULL,
  phone        TEXT NOT NULL,          -- kept for abuse investigation only, never shown to the recipient
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_shares_token_ix ON route_shares (token_hash);
