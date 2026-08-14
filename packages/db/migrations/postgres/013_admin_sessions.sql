-- 013_admin_sessions: prepare the sessions table, unused since 001_core, for
-- real browser sessions.
--
-- `sessions.id` keeps its text PRIMARY KEY and now holds the SHA-256 hex
-- digest of the cookie's token rather than the token itself -- the same
-- reasoning that makes projects.server_key_hash a hash, so that a Postgres
-- read leak is not a set of live sessions. That is a change in meaning, not
-- in shape, and no existing row can conflict with it because nothing has
-- ever written to this table.
--
-- Additive only, and it drops nothing: a later migration must never make an
-- earlier one unrunnable.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Serves SessionStore.sweep(), which deletes every expired row on an
-- interval. Without it that sweep is a sequential scan on every run.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
