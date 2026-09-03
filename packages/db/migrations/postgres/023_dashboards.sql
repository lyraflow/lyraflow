-- 023_dashboards: named layouts of saved reports.
--
-- A dashboard is a name and an ordered list of TILES, each one a reference
-- to a saved report -- a trend (020), a retention report (020) or a funnel
-- (012) -- by kind and id, plus a width. Nothing else: no inline
-- definitions, no range, no cached result.
--
-- THE TILES ARE ONE JSON ARRAY, NOT A TABLE OF ROWS, for the reason
-- `funnels.steps` is: a layout is edited as a whole (reorder, resize, add,
-- remove), so one PATCH replacing the array is the whole write path. As
-- rows it would be a tile route family plus a position uniqueness
-- constraint every reorder has to step around. Position is array index;
-- there is no tile id.
--
-- `definition_version` is a column for 012's reason: the tiles are parsed
-- JSON, and a future migration that changes their shape must find every
-- old row with a WHERE, not by parsing all of them. A row whose tiles no
-- longer parse comes back `stale: true`, never thrown.
--
-- NO FOREIGN KEY from a tile to its report, for the reason `segment_id`
-- carries none in 012 and 020: CASCADE would remove tiles as a side effect
-- of deleting a report and the dashboard would silently reshape; SET NULL
-- cannot apply to a JSON element. The read path looks each report up,
-- finds it missing, and the tile says so, naming the kind and id. The
-- dashboard is what tells the operator a report they relied on is gone.
--
-- THE RANGE IS DELIBERATELY NOT STORED, for 020's reason exactly: a
-- dashboard is the question, and the window is a property of the question
-- being asked THIS time. One range, chosen by the viewer, applies to every
-- tile, and lives in the screen's URL.
--
-- The 12-tile cap is a CHECK as well as validation, for 012's reason: the
-- real cap runs before a write, and the CHECK is the ceiling that must hold
-- for any row however it arrived. Twelve is also the most a dashboard may
-- ask ClickHouse to do when opened.
--
-- ONE HOME PER PROJECT is a partial unique index, not application logic:
-- two concurrent PATCHes cannot both win at the database. The route sets a
-- new home by clearing the old one and setting the new one in one
-- transaction.

CREATE TABLE IF NOT EXISTS dashboards (
  id                 bigserial   PRIMARY KEY,
  project_id         bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  definition_version integer     NOT NULL,
  tiles              jsonb       NOT NULL DEFAULT '[]',
  is_home            boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  CONSTRAINT dashboards_tiles_is_array   CHECK (jsonb_typeof(tiles) = 'array'),
  CONSTRAINT dashboards_tiles_at_most_12 CHECK (
    jsonb_typeof(tiles) <> 'array' OR jsonb_array_length(tiles) <= 12)
);

CREATE UNIQUE INDEX IF NOT EXISTS dashboards_one_home_per_project
  ON dashboards (project_id) WHERE is_home;
