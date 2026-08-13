-- Extend the request state machine with 'cancelled' (either party can back out before arrival)
-- and 'arrived' as a fact recorded on an accepted request (arrived_at), not a new status —
-- an arrived request stays status='accepted' so existing review-eligibility logic
-- (reviews/routes.ts: "reviews are only allowed on accepted requests") needs no change at all.

DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'requests' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%status%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE requests DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN ('requested','seen','accepted','rejected','timed_out','cancelled'));

ALTER TABLE requests ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cancelled_by TEXT CHECK (cancelled_by IN ('household','collector'));

-- Arrival-detection radius (metres) — live-tunable like the rest of app_config (design §17).
INSERT INTO app_config (key, value) VALUES ('arrival_radius_m', '40') ON CONFLICT (key) DO NOTHING;
