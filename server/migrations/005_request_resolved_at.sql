-- 004_request_guards.sql's recency index used responded_at as the "when did this become
-- historical" signal, but responded_at is deliberately COALESCE-preserved by /:id/cancel (it
-- means "when the collector first responded" — accept/reject — a distinct fact). That meant
-- cancelling an *already-accepted* request never advanced responded_at, so the just-cancelled
-- request sorted by its stale acceptance time instead of the cancellation that actually just
-- happened — found while writing the very test meant to prove 004's ordering fix worked.
--
-- resolved_at is a dedicated "this request just became historical" timestamp instead:
-- reject/timeout set it at the same instant as responded_at (for those two, it's genuinely the
-- same moment); cancel now sets it unconditionally, every time, regardless of whether
-- responded_at already had a value from an earlier accept.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

DROP INDEX IF EXISTS requests_recency_ix;
CREATE INDEX requests_recency_ix ON requests (COALESCE(arrived_at, resolved_at, requested_at) DESC);
