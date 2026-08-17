-- "Route me" — admin visibility + "found" success marker.
--   delivered:     persisted so the admin list can show it (previously only ever returned in the
--                   HTTP response, never written to the row).
--   receiver_lon/lat: the recipient's first-fix position, captured once and never overwritten —
--                   "where did the recipient originally start from", for the admin's map view.
--   found_at:      set once, the first time a check-in lands within 150m of the sender.

ALTER TABLE route_shares
  ADD COLUMN IF NOT EXISTS delivered    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS receiver_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS receiver_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS found_at     TIMESTAMPTZ;
