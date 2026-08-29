-- 020_saved_reports: saved trend and retention definitions.
--
-- Mirrors `segments` (007) and `funnels` (012), including the parts those two
-- learned the hard way, and departs from them in exactly one place (see
-- `definition_version` below).
--
-- THE RANGE IS DELIBERATELY NOT STORED, for the reason 012 gives about
-- funnels: the definition is the question, and the window is a property of
-- the question being asked THIS time. Storing it would make "signups by day,
-- last week" and "signups by day, this month" two rows describing one report.
--
-- The consequence is real and is handled in the UI rather than here: a trend
-- stored at `1m` reopened over a wide range asks for more buckets than the
-- server will serve, so the screen must warn ON LOAD and not only on change.
--
-- NO CACHED LAST-RUN SNAPSHOT, unlike funnels. Funnels caches counts so its
-- list renders without N ClickHouse scans, and pays for it with an
-- invalidation rule -- a PATCH that changes the definition must clear the
-- cache in the same statement or the list shows a confident number for a
-- definition that no longer exists. These lists render the definition itself,
-- which is derived from the row being displayed and cannot go stale.
--
-- `trend_reports` HAD NO `definition_version` AND `retention_reports` DOES.
-- The argument was that 012 justifies the column as "what a future migration
-- filters on. Finding every v1 definition must not require parsing every
-- row" -- which holds only for a definition that must be PARSED, and a
-- trend's was three scalar columns. THAT IS NO LONGER TRUE: 021 adds
-- `event_where` (the segment grammar, JSON, versioned) and with it
-- `definition_version`. This paragraph is kept rather than deleted because
-- the reasoning is still the right test to apply; it is the premise about
-- trends that changed. See 021_trend_predicates.sql.
--
-- `segment_id` carries NO foreign key, for 012's reasons exactly. CASCADE
-- would destroy every report built on a segment as a side effect of tidying
-- up a population. SET NULL is worse: once the column is null the report no
-- longer records that it ever HAD a restriction, so "this now runs over
-- everyone" is indistinguishable from "this was always unrestricted", and the
-- warning that should announce the change cannot be generated. Keeping the id
-- with no constraint preserves it -- the run path looks it up, finds it
-- missing, runs over everyone and says so. There is a second reason: 007
-- begins with DROP TABLE IF EXISTS segments, and a dependent table makes that
-- drop fail, so a replay of 007 would break.

CREATE TABLE IF NOT EXISTS trend_reports (
  id          bigserial   PRIMARY KEY,
  project_id  bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  event       text        NOT NULL,
  interval    text        NOT NULL,
  group_by    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CONSTRAINT trend_reports_interval_known CHECK (interval IN ('1m','1h','1d','1w'))
);

CREATE INDEX IF NOT EXISTS trend_reports_project_idx ON trend_reports (project_id, name);

CREATE TABLE IF NOT EXISTS retention_reports (
  id                 bigserial   PRIMARY KEY,
  project_id         bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  definition_version integer     NOT NULL,
  start_event        text        NOT NULL,
  return_event       text        NOT NULL,
  start_where        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  return_where       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  granularity        text        NOT NULL,
  periods            integer     NOT NULL,
  segment_id         bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CONSTRAINT retention_reports_granularity_known CHECK (granularity IN ('day','week','month')),
  CONSTRAINT retention_reports_periods_positive  CHECK (periods > 0),
  CONSTRAINT retention_reports_where_are_arrays  CHECK (
    jsonb_typeof(start_where) = 'array' AND jsonb_typeof(return_where) = 'array')
);

CREATE INDEX IF NOT EXISTS retention_reports_project_idx ON retention_reports (project_id, name);
