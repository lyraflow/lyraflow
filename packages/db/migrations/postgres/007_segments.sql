-- 007_segments: saved segments with a last-run snapshot.
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
