-- Captures where the collector actually was the moment they accepted a request, so both sides
-- can later see how far the collector has travelled since then (straight-line displacement from
-- this snapshot to their current live position, not a full path/odometer — see the discussion
-- that led to this: a real path would need a position-history table and a write on every
-- heartbeat, which is exactly the write pressure the Redis/Postgres-quota work just cut).
-- NULL for any request accepted before this migration, or if the collector had never gone online
-- (no last_lon/last_lat yet) at accept time — the "travelled" UI simply has no baseline to show.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS accept_lon DOUBLE PRECISION;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS accept_lat DOUBLE PRECISION;
