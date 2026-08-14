-- 012_funnels: saved funnel definitions with a last-run snapshot.
--
-- Mirrors `segments` (007) deliberately, including the three things that
-- migration learned the hard way:
--
-- `definition_version` is a column rather than only a field inside `steps`,
-- because it is what a future migration filters on. Finding every v1
-- definition must not require parsing every row.
--
-- `last_entered`, `last_converted` and `last_evaluated_at` are a CACHE, not a
-- fact. They are written whenever the funnel runs, nothing recomputes them in
-- the background, and they are always rendered alongside their timestamp
-- rather than as a bare number. Their purpose is to let a funnels-list screen
-- render N rows from stored numbers instead of firing N ClickHouse scans. A
-- PATCH that changes `steps`, `window_seconds` or `segment_id` must clear all
-- three in the same statement: a stored count describes the definition it was
-- computed from, and leaving it after an edit makes the list display a
-- confident number for a funnel that no longer exists.
--
-- `segment_id` carries NO foreign key, deliberately, and this was arrived at
-- by trying the other two first.
--
-- ON DELETE CASCADE is plainly wrong: deleting a segment would destroy every
-- report built on it as a side effect of tidying up a population.
--
-- ON DELETE SET NULL is what this migration originally had, and it is wrong
-- more subtly. Once the column is null the funnel no longer records that it
-- ever HAD a restriction, so "this funnel is now running over everyone" is
-- indistinguishable from "this funnel was always unrestricted" — and the
-- warning that is supposed to announce the change cannot be generated at all.
-- The information the operator needs is destroyed by the very action they need
-- to be told about.
--
-- Keeping the id and no constraint preserves it: the run path looks the
-- segment up, finds it missing, runs over everyone and says so, naming the id.
-- A dangling reference is checked where it matters rather than prevented in a
-- way that erases the evidence.
--
-- There is a second, independent reason the FK could not stay. 007_segments
-- begins with `DROP TABLE IF EXISTS segments`, and a dependent table makes
-- that drop fail — so a replay of 007 (which the migration tests do, against a
-- shared database) breaks. A later migration must not make an earlier one
-- unrunnable.
--
-- The range (`since`/`until`) is deliberately NOT stored. The window is a
-- property of the funnel — how long someone gets to finish — while the range
-- is a property of the question being asked this time. Storing it would make
-- "the signup funnel, last week" and "the signup funnel, this week" two rows
-- describing one funnel.

CREATE TABLE IF NOT EXISTS funnels (
  id                 bigserial   PRIMARY KEY,
  project_id         bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  definition_version integer     NOT NULL,
  steps              jsonb       NOT NULL,
  window_seconds     integer     NOT NULL,
  segment_id         bigint,
  last_entered       bigint,
  last_converted     bigint,
  last_evaluated_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  -- The caps live in validate.ts and are enforced before a definition is
  -- written. These two are the floor and ceiling that must hold for any row
  -- however it got here, so a hand-written INSERT cannot store a funnel the
  -- compiler would refuse to run.
  CONSTRAINT funnels_window_positive CHECK (window_seconds > 0 AND window_seconds <= 2592000),
  CONSTRAINT funnels_steps_is_array CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX IF NOT EXISTS funnels_project_idx ON funnels (project_id, name);
