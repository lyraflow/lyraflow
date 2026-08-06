-- Identity lives in Postgres, not ClickHouse, because it needs a foreign key
-- to projects and a uniqueness guarantee that ClickHouse cannot express.
--
-- The table stores bind events, not ranges. A range-based design (one row per
-- validity window, mutated by narrowing/inserting as new identifies arrive)
-- makes the result depend on the order writes are applied in: whichever
-- identify() is processed first wins the -infinity slot, and a late,
-- out-of-order identify can hand one person's history to another. Bind events
-- have no such problem — a set has no order — so the range for a device is
-- always *derived* from its events (see identity_bindings_dict_src below),
-- never stored directly. This is also why there is no exclusion constraint
-- here: overlap is impossible when nothing but instants is ever written.
CREATE TABLE IF NOT EXISTS identity_bindings (
  id           bigserial   PRIMARY KEY,
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  anonymous_id text        NOT NULL,
  person_id    text        NOT NULL,
  bound_at     timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One row per (device, instant): a device can only be bound to one person as
  -- of any given moment. Two different persons colliding on the identical
  -- instant is a genuine tie with no correct answer; the write path (Task 3)
  -- breaks it deterministically with
  -- `ON CONFLICT (project_id, anonymous_id, bound_at)
  --  DO UPDATE SET person_id = LEAST(identity_bindings.person_id, EXCLUDED.person_id)`
  -- — lexicographically smaller wins, arbitrary but identical regardless of
  -- which of the two events arrives first.
  UNIQUE (project_id, anonymous_id, bound_at)
);

CREATE INDEX IF NOT EXISTS identity_bindings_person_idx
  ON identity_bindings (project_id, person_id);

CREATE TABLE IF NOT EXISTS person_aliases (
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person_id    text        NOT NULL,
  canonical_id text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, person_id),
  -- Alias chains are always flattened to depth 1 at write time, so a person may
  -- never point at itself; that would be a one-element cycle.
  CONSTRAINT person_aliases_not_self CHECK (person_id <> canonical_id)
);

CREATE INDEX IF NOT EXISTS person_aliases_canonical_idx
  ON person_aliases (project_id, canonical_id);

-- Derives the tiling from bind events with a window function: ordered by
-- bound_at within each device, the earliest event owns everything before it
-- (retroactive attachment — the whole point of identity resolution, asserted
-- explicitly via the NULL-lag case below rather than left as an accident of
-- how lag() handles a missing preceding row), each event owns up to whichever
-- event comes next, and the latest is open-ended. Adjacent rows for the same
-- person are never collapsed — both resolve to that person either way, so
-- collapsing would be pure bookkeeping with no observable effect on the
-- derived range.
--
-- ClickHouse dictionaries cannot parse Postgres ±infinity into DateTime — the
-- dictionary fails to load entirely, and every identity lookup silently falls
-- back to the anonymous id. Clamp to the DateTime range ClickHouse can
-- represent.
CREATE OR REPLACE VIEW identity_bindings_dict_src AS
SELECT
  project_id,
  anonymous_id,
  person_id,
  CASE WHEN lag(bound_at) OVER w IS NULL
       THEN timestamptz '1970-01-01 00:00:00+00'
       ELSE GREATEST(bound_at, timestamptz '1970-01-01 00:00:00+00')
  END AS valid_from,
  LEAST(COALESCE(lead(bound_at) OVER w, timestamptz 'infinity'),
        timestamptz '2106-02-07 06:28:15+00') AS valid_to
FROM identity_bindings
WINDOW w AS (PARTITION BY project_id, anonymous_id ORDER BY bound_at);

CREATE OR REPLACE VIEW person_aliases_dict_src AS
SELECT project_id, person_id, canonical_id FROM person_aliases;
