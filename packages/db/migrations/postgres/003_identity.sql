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
--
-- valid_to is the next bind's bound_at MINUS one second, not the bound_at
-- itself. `deriveTiling` in @lyraflow/core models a tile as half-open
-- [from, to) — the outgoing person's range ends exactly where the incoming
-- one begins, with no shared instant — but ClickHouse's
-- RANGE(MIN valid_from MAX valid_to) is inclusive at *both* ends. Emitting
-- valid_to = lead(bound_at) unmodified therefore makes the outgoing and
-- incoming tiles overlap at that exact instant, and with
-- range_lookup_strategy defaulting to 'min', the older tile wins the tie.
-- Because resolvedPersonExpr floors every event to the second before the
-- dictGet (identity_bindings' RANGE columns are DateTime, one-second
-- resolution — see resolve.ts), that one-instant overlap is really a
-- one-second window: any event timestamped in [bound_at, bound_at + 1s)
-- after a rebind resolved to the person being replaced, not the one taking
-- over (see resolve.test.ts's live 'does not misattribute an event landing
-- within the same second as a rebind' for the reproduction). Subtracting
-- one second — the smallest step this column's own resolution can express —
-- is what actually achieves half-open behaviour once discretised to
-- seconds. Only the finite (has-a-successor) branch subtracts: the open
-- upper end has no successor to butt up against, so it is left at its
-- ClickHouse-representable clamp, unmodified — mirrored in
-- `deriveTiling`/bindings.test.ts's `assertViewMatchesReference`, which
-- applies the identical -1s adjustment only when a tile is not the last.
--
-- The outer WHERE below exists because that same -1s subtraction can invert
-- a tile: two binds for one device inside the same wall-clock second, where
-- the earlier is not the device's first-ever bind, produce
-- valid_to = lead(bound_at) - 1s < valid_from = bound_at (e.g. binds at
-- 09:00:00.000 and 09:00:00.500 give the earlier tile [09:00:00, 08:59:59]).
-- Reachable from the write path: bindings.ts stores bound_at at millisecond
-- precision, so two identify() calls landing in one ingest batch land here.
--
-- Checked empirically against a live ClickHouse (not assumed): loading such
-- a row does NOT fail the dictionary — status stays LOADED, last_exception
-- stays empty — but the row itself is never matched by any dictGet lookup
-- (range_min > range_max can never satisfy range_min <= x <= range_max), so
-- that person's tile silently vanishes and neighbouring lookups quietly
-- absorb it. That is a narrower failure than the ±infinity/CANNOT_PARSE_DATETIME
-- case this view's clamps already guard against above, but it is still
-- exactly the "nothing visibly broken" failure class those guard against:
-- the dictionary looks healthy, and a person who held a device for under a
-- second becomes permanently unresolvable without anyone noticing.
--
-- Filtered out rather than clamped (e.g. GREATEST(valid_to, valid_from)):
-- clamping would produce a *zero-width* tile sitting at the same
-- ClickHouse-truncated second as its successor's own (equally truncated)
-- valid_from — reintroducing, for this one pair, the exact same-instant tie
-- range_lookup_strategy's undocumented 'min' behaviour that the -1s fix
-- above exists to avoid. Dropping the row instead leaves a brief (well
-- under 2 second) gap with no matching tile at all, which dictGetOrDefault
-- answers with its caller-supplied default (the event's own anonymous_id) —
-- the same safe, designed-for fallback an unbound device already gets, and
-- never a specific wrong person.
--
-- This filter also closes a second, narrower gap without a dedicated guard:
-- a successor bind at/near the Unix epoch could otherwise send valid_to
-- below 1970-01-01, outside what ClickHouse's DateTime can represent at
-- all. valid_from carries an unconditional GREATEST(..., epoch) clamp (see
-- above), so it can never itself be earlier than epoch — meaning any row
-- whose valid_to underflows before epoch necessarily has valid_to <
-- valid_from already, and is caught by this same WHERE. No separate
-- GREATEST guard is needed; a symmetric one has nothing left to do.
CREATE OR REPLACE VIEW identity_bindings_dict_src AS
SELECT project_id, anonymous_id, person_id, valid_from, valid_to
FROM (
  SELECT
    project_id,
    anonymous_id,
    person_id,
    CASE WHEN lag(bound_at) OVER w IS NULL
         THEN timestamptz '1970-01-01 00:00:00+00'
         ELSE GREATEST(bound_at, timestamptz '1970-01-01 00:00:00+00')
    END AS valid_from,
    CASE WHEN lead(bound_at) OVER w IS NULL
         THEN timestamptz '2106-02-07 06:28:15+00'
         ELSE LEAST(lead(bound_at) OVER w - INTERVAL '1 second',
                    timestamptz '2106-02-07 06:28:15+00')
    END AS valid_to
  FROM identity_bindings
  WINDOW w AS (PARTITION BY project_id, anonymous_id ORDER BY bound_at)
) tiled
WHERE valid_to >= valid_from;

CREATE OR REPLACE VIEW person_aliases_dict_src AS
SELECT project_id, person_id, canonical_id FROM person_aliases;
