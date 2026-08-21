-- 019_project_delete: destroying a project, in an order that cannot orphan
-- ClickHouse data.
--
-- Archiving (018) stops a project without destroying it, and said delete
-- stays open behind it. This is that delete. It is not one statement:
-- Postgres cascades cleanly (every project-scoped table carries ON DELETE
-- CASCADE), while ClickHouse splits two ways -- `events`, `device_index` and
-- `person_traits` are partitioned by project_id and are dropped, while
-- `event_schema` (no partitioning) and `events_dead_letter` (partitioned by
-- received_at) need asynchronous ALTER ... DELETE mutations.
--
-- THE ORDER IS THE WHOLE POINT. RetentionStore.listProjects() derives its
-- targets from this table, so a project whose Postgres row is gone while its
-- ClickHouse partitions remain is never swept and never reported (#39).
-- Postgres therefore goes LAST, and only after a read confirms ClickHouse
-- holds zero rows for the project.

-- NULL means alive. Stamped when the delete is requested and never cleared:
-- there is no cancel. Deliberately NOT `disabled_at` reused -- ingest must be
-- able to answer `project_deleted` rather than lie with `project_archived`,
-- and restoring an archived project must never be able to resurrect one that
-- is being destroyed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleting_at timestamptz;

CREATE TABLE IF NOT EXISTS project_deletions (
  id           bigserial   PRIMARY KEY,
  -- NO FOREIGN KEY, unlike deletion_requests.project_id. The last act of the
  -- purge is `DELETE FROM projects`; ON DELETE CASCADE would erase this row
  -- at the exact moment it succeeded, and the status endpoint would answer
  -- 404 to the one question it exists to answer.
  project_id   bigint      NOT NULL,
  -- Snapshotted for the same reason: after the cascade, this row is the only
  -- surviving evidence that the project existed. Completed rows are kept
  -- indefinitely -- they are tombstones, and they are tiny.
  slug         text        NOT NULL,
  name         text        NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- The lease, with the same meaning as deletion_requests.claimed_at: a
  -- claim by a process that then dies becomes claimable again once it ages
  -- past the lease window, and the work restarts FROM THE TOP. Every step is
  -- predicated on project_id, so re-running one is a no-op.
  claimed_at   timestamptz,
  -- Set only after the verify read returned zero for all five ClickHouse
  -- tables AND the Postgres row was deleted.
  completed_at timestamptz,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text
);

CREATE INDEX IF NOT EXISTS project_deletions_pending_idx
  ON project_deletions (requested_at)
  WHERE completed_at IS NULL;
