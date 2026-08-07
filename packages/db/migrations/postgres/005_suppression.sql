-- 005_suppression: people whose data must not appear in any query result.
--
-- A row here is written when a deletion is requested and is NEVER removed,
-- including after the asynchronous purge finishes. That is deliberate: the
-- suppression list is in Postgres and is therefore itself backed up, so
-- restoring an older backup of the event store cannot resurrect a deleted
-- person. Removing the row after purge would make the guarantee depend on
-- every backup being newer than every deletion, which is not a guarantee at
-- all.
--
-- The deletion API and the purge job that write here are a later plan. This
-- table exists now because the segment compiler injects the filter that reads
-- it, and a filter that "cannot be omitted by a caller" has to be built
-- before the first caller, not retrofitted after.
CREATE TABLE IF NOT EXISTS suppressed_persons (
  project_id    bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The CANONICAL person id, resolved at deletion time. Suppressing a
  -- pre-alias id would leave the survivor visible, which is the same class of
  -- defect as an unresolved stage 2 in resolvedPersonExpr.
  person_id     text        NOT NULL,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, person_id)
);

-- The dictionary source view, following the same convention as
-- identity_bindings_dict_src and person_aliases_dict_src: the ClickHouse
-- dictionary reads a view, never a table directly, so the shape the
-- dictionary depends on is versioned here in the migration rather than
-- embedded in the boot-time DDL.
--
-- `suppressed` is a constant 1 rather than a stored column because every row
-- in this table means exactly the same thing. The attribute exists only
-- because a ClickHouse dictionary must declare at least one non-key
-- attribute; every read goes through dictHas(), never dictGet().
CREATE OR REPLACE VIEW suppressed_persons_dict_src AS
SELECT project_id, person_id, 1 AS suppressed
FROM suppressed_persons;
