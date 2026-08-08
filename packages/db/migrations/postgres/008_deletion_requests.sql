-- 008_deletion_requests: the queue the purge worker drains, and the
-- dictionary source view that makes suppression time-scoped.
--
-- A deletion writes TWO rows in one transaction: the suppressed_persons
-- upsert (005) that hides the person's past immediately, and one row here
-- that schedules the erasure. Splitting them gives either suppression with
-- no purge (hidden forever, never erased) or a purge with no suppression
-- (visible until the worker arrives), and neither is recoverable by retry
-- because the endpoint has already returned 202.
CREATE TABLE IF NOT EXISTS deletion_requests (
  id           bigserial   PRIMARY KEY,
  project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The CANONICAL person id, resolved at request time — same rule as
  -- suppressed_persons.person_id, and for the same reason: purging a
  -- pre-alias id would leave the survivor's data in place.
  person_id    text        NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- The lease. NULL until a worker takes the request; a claim by a process
  -- that then dies becomes claimable again once this ages past the lease
  -- window, and the worker restarts that request FROM THE TOP. Every step is
  -- a delete predicated on the person, so re-running one is a no-op.
  claimed_at   timestamptz,
  -- Set only when every step has CONFIRMED. ClickHouse mutations are
  -- asynchronous by default; the worker runs them with mutations_sync = 1 so
  -- this cannot come to mean "I asked".
  completed_at timestamptz,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text
);

-- The claim statement's index: it orders by requested_at over rows that are
-- not yet complete, and nothing else scans this table hot.
CREATE INDEX IF NOT EXISTS deletion_requests_pending_idx
  ON deletion_requests (requested_at)
  WHERE completed_at IS NULL;

-- Suppression becomes TIME-SCOPED: reads hide a person's events at or before
-- this instant, and show later ones. An erased user who keeps using the
-- customer's application resolves to the same person and must not be
-- invisible forever — erasure is a right to have past data deleted, not a
-- promise never to be measured again.
--
-- `suppressed` stays a constant 1: dictHas() is still the guard (see
-- dictionaries.ts for why the two halves of the filter have opposite failure
-- modes), and removing an attribute a shipped dictionary declares would be
-- an amendment to 005 rather than a step forward from it.
--
-- Clamped to the range ClickHouse's DateTime can represent, exactly as
-- identity_bindings_dict_src clamps its own bounds (003_identity.sql): a
-- value outside it does not degrade the lookup, it fails the whole
-- dictionary load with CANNOT_PARSE_DATETIME. With dictHas() throwing on an
-- unloaded dictionary that fails closed rather than open, which is the right
-- direction — but a self-inflicted outage is still an outage, and the clamp
-- costs nothing. The application only ever writes now(), so this never fires
-- for a row this product wrote.
CREATE OR REPLACE VIEW suppressed_persons_dict_src AS
SELECT
  project_id,
  person_id,
  1 AS suppressed,
  GREATEST(
    LEAST(suppressed_at, timestamptz '2106-02-07 06:28:15+00'),
    timestamptz '1970-01-01 00:00:00+00'
  ) AS suppressed_at
FROM suppressed_persons;
