-- Two independent guards, both requested directly by the user:
--
-- 1. A household could send multiple simultaneous requests to the exact same collector — there
--    was nothing stopping it (no unique constraint, no application check). A partial unique
--    index is the same DB-enforced, race-proof pattern already used for review dedup
--    (UNIQUE(author_id, request_id) in 001_init.sql) rather than a check-then-insert, which a
--    rapid double-tap could still slip past. Only covers requests that are still "live" for
--    this pair — a household can send a fresh request to a collector once an earlier one with
--    them is fully resolved (rejected/timed_out/cancelled) or the collector has arrived.
CREATE UNIQUE INDEX IF NOT EXISTS requests_active_pair_ux
  ON requests (household_id, collector_id)
  WHERE status IN ('requested', 'seen', 'accepted') AND arrived_at IS NULL;

-- 2. History should show whatever most recently became historical first, not whatever was most
--    recently *created* first — a request accepted hours ago and only just now cancelled should
--    outrank an unrelated request created five minutes ago but already timed out. `responded_at`/
--    `arrived_at` are NULL until a request actually resolves, so this index still serves the
--    active/pending lists (which fall through to requested_at) at no extra cost.
--    (Superseded by 005_request_resolved_at.sql, which found `responded_at` wasn't quite the
--    right column for this and swapped in a dedicated `resolved_at` — see that file's comment.
--    Left as originally written here rather than edited in place: this file was already applied
--    against a real database by the time that gap was found, and migrations are tracked by
--    filename, not content, so editing an already-applied file silently does nothing on a
--    database that has already run it.)
CREATE INDEX IF NOT EXISTS requests_recency_ix
  ON requests (COALESCE(arrived_at, responded_at, requested_at) DESC);
