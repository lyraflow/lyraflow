-- 021_trend_predicates: a saved trend can now carry a `where` predicate list.
--
-- THIS SUPERSEDES AN ARGUMENT IN 020. That file says, at length, that
-- `trend_reports` needs no `definition_version` because "a trend's definition
-- is three scalar columns; a future change to it is an ALTER TABLE and
-- finding affected rows is a WHERE on a real column." That was true and is
-- now false: the definition contains the segment `where` grammar, which is
-- JSON parsed against a schema that versions independently. 020's header has
-- been corrected to point here rather than left standing to be believed.
--
-- `event_where`, not `where`: `where` is a reserved word and would need
-- quoting in every hand-written statement from here on. It also matches
-- `retention_reports`' own `start_where`/`return_where`. The column is the
-- only spelling that differs -- the wire field, the TypeScript property and
-- the URL parameter are all `where`, and `TrendStore` maps the one field.
--
-- `event_where` KEEPS its default and `definition_version` does not. "No
-- filter" is a real and common value that no writer should have to state;
-- a version stamp is something every insert must decide, and a defaultable
-- one is a stamp an insert can forget. The default is added first only so
-- the existing rows are backfilled, then dropped -- which leaves the column
-- in exactly the shape `retention_reports.definition_version` already has.
--
-- The CHECK is what stands between a hand-written UPDATE and a store that
-- reports every row stale. `retention_reports` carries the same one.

ALTER TABLE trend_reports
  ADD COLUMN IF NOT EXISTS event_where        jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS definition_version integer NOT NULL DEFAULT 1;

ALTER TABLE trend_reports ALTER COLUMN definition_version DROP DEFAULT;

ALTER TABLE trend_reports DROP CONSTRAINT IF EXISTS trend_reports_where_is_array;
ALTER TABLE trend_reports ADD CONSTRAINT trend_reports_where_is_array
  CHECK (jsonb_typeof(event_where) = 'array');
