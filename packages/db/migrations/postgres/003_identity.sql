-- Identity lives in Postgres, not ClickHouse, because bindings are MUTATED: a new
-- binding closes the previous one. Postgres can also enforce non-overlapping validity
-- ranges natively, which ClickHouse cannot express at all.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS identity_bindings (
  id           bigserial   PRIMARY KEY,
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  anonymous_id text        NOT NULL,
  person_id    text        NOT NULL,
  valid_range  tstzrange   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The whole point of this table. Overlapping ranges for one device would make
  -- resolution ambiguous, and a range-hashed dictionary would silently pick one.
  CONSTRAINT identity_bindings_no_overlap
    EXCLUDE USING gist (project_id WITH =, anonymous_id WITH =, valid_range WITH &&),
  CONSTRAINT identity_bindings_range_nonempty CHECK (NOT isempty(valid_range))
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

-- ClickHouse dictionaries cannot parse Postgres ±infinity into DateTime — the
-- dictionary fails to load entirely, and every identity lookup silently falls back
-- to the anonymous id. Clamp to the DateTime range ClickHouse can represent.
-- Postgres keeps the true infinities so the exclusion constraint stays natural.
CREATE OR REPLACE VIEW identity_bindings_dict_src AS
SELECT
  project_id,
  anonymous_id,
  person_id,
  GREATEST(lower(valid_range), timestamptz '1970-01-01 00:00:00+00') AS valid_from,
  LEAST(COALESCE(upper(valid_range), timestamptz 'infinity'),
        timestamptz '2106-02-07 06:28:15+00')                        AS valid_to
FROM identity_bindings;

CREATE OR REPLACE VIEW person_aliases_dict_src AS
SELECT project_id, person_id, canonical_id FROM person_aliases;
