-- 024_dashboard_shares: one secret link per dashboard.
--
-- A dashboard can be SHARED: reachable at /shared/<token> by anyone holding
-- the token, with no login, read-only, running only the tiles it already
-- holds. The share is two columns on the row rather than a table, because
-- there is exactly one link per dashboard and nothing else to join;
-- deleting the dashboard deletes the link with it.
--
-- THE TOKEN IS STORED IN PLAINTEXT. It is a read credential for one
-- dashboard, and the operator's share card shows the same link again on
-- every visit rather than "you will not see this again". A database leak
-- already exposes everything the token guards, so hashing it would protect
-- nothing while costing that. A session token is hashed for a different
-- reason: it can delete projects.
--
-- The pair CHECK is 022's `projects_previous_write_key_pair` again: both
-- columns set, or neither. A token without a date, or a date without a
-- token, is a state no code path writes and none should read.
--
-- The partial unique index is what makes the token a lookup key, and it is
-- partial for 022's reason: NULL is "unshared", not a value, and every
-- unshared row would otherwise collide with every other.

ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS share_token text,
  ADD COLUMN IF NOT EXISTS shared_at   timestamptz;

ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_share_pair;
ALTER TABLE dashboards ADD CONSTRAINT dashboards_share_pair
  CHECK ((share_token IS NULL) = (shared_at IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS dashboards_share_token_key
  ON dashboards (share_token) WHERE share_token IS NOT NULL;
