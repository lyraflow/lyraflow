-- 007_segments: saved segments with a last-run snapshot.
--
-- The 001_core migration created an early version of this table with the
-- shape (filter_tree, no cache columns) that no code in the product ever read
-- or wrote — segments had no store layer at the time it was scaffolded. The
-- plan now requires a different schema, and this migration reshapes the table
-- by dropping and recreating it. This is safe because:
--
-- - The product is pre-release and no operator holds persistent data in
--   deployed segments tables.
-- - 001_core is left untouched; amending an already-applied migration would
--   not reach the deployments that need the change (migrate() skips any version
--   recorded in schema_migrations).
-- - A DROP is idempotent in a database test that replays migrations after
--   dropping schema_migrations.
--
-- `ast_version` is a column rather than only a field inside `filter` because
-- it is what a future migration filters on. Finding every v1 tree must not
-- require parsing every row.
--
-- `last_count` and `last_evaluated_at` are a CACHE, not a fact. They are
-- written whenever the segment runs, and are always rendered alongside their
-- timestamp rather than as a bare number. Nothing recomputes them in the
-- background. Their purpose is to let a segments-list screen render N rows
-- from stored numbers instead of firing N compiled ClickHouse queries.
--
-- A PATCH that changes `filter` must clear both in the same statement: a
-- stored count describes the tree it was computed from, and leaving it in
-- place after an edit makes the list display a confident number for a
-- segment that no longer exists.
DROP TABLE IF EXISTS segments;

CREATE TABLE IF NOT EXISTS segments (
  id                bigserial   PRIMARY KEY,
  project_id        bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              text        NOT NULL,
  ast_version       integer     NOT NULL,
  filter            jsonb       NOT NULL,
  last_count        bigint,
  last_evaluated_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS segments_project_idx ON segments (project_id, name);
