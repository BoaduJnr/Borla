-- Turn the one-reply-per-review cap into an open, multi-message thread: either party to a
-- request can now post as many replies as they like, not just "the reviewed party, exactly
-- once" (server/src/modules/reviews/routes.ts). Drop the UNIQUE(review_id) constraint that
-- enforced the old cap, looked up by definition rather than guessed name (same defensive
-- pattern as 002_request_lifecycle.sql) since it was declared inline with no explicit name.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT con.conname INTO con_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'review_replies' AND con.contype = 'u'
    AND pg_get_constraintdef(con.oid) LIKE '%review_id%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE review_replies DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS review_replies_review_ix ON review_replies (review_id, created_at);

-- The double-blind reciprocal-release sweep is gone (reviews/replies now go visible
-- individually on their own moderation pass — jobs/workers.ts) so this knob no longer does
-- anything; remove it rather than leave a config row that silently has no effect.
DELETE FROM app_config WHERE key = 'review_window_days';
