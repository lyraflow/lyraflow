-- 004_person_traits: traits explicitly set through identify(), unpivoted to
-- one row per trait key so that keys set at different times merge instead of
-- replacing each other.
--
-- Two deliberate departures from the design spec's `persons` sketch:
--
-- 1. Keyed by RAW identity (anonymous_id, user_id), not by a resolved
--    person_id, for the same reason device_index is: at insert time the
--    binding usually does not exist yet, because the anonymous events that
--    precede an identify() arrive before the identify() that names the
--    person. Resolution therefore happens at query time, exactly as it does
--    for events and device_index. Keying this table on a person would mean
--    resolving at insert time, which is not possible in a materialised view.
--
-- 2. One row per (identity, trait_key) rather than one Map column per
--    person. ReplacingMergeTree replaces whole rows, so a Map column would
--    lose every key not present in the newest identify() -- a person who
--    sets `plan` on Monday and `role` on Tuesday would end Tuesday with only
--    `role`. Unpivoting makes "last write wins" apply per key, which is what
--    a trait actually means.
--
-- value_str and value_num are separate columns rather than one stringified
-- column because properties and properties_num are already routed apart at
-- ingest (see routeProperties in @lyraflow/core), and collapsing them here
-- would make `3` and `"3"` interchangeable -- which the ingest API documents
-- that they are not.
CREATE TABLE IF NOT EXISTS person_traits (
  project_id   UInt32,
  anonymous_id String,
  user_id      String,
  trait_key    String,
  value_str    AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  value_num    AggregateFunction(argMax, Float64, DateTime64(3, 'UTC')),
  -- Distinguishes "numeric trait whose value is 0" from "string trait, so
  -- value_num is a meaningless default". A predicate on a numeric trait must
  -- test this before trusting value_num.
  has_num      AggregateFunction(argMax, UInt8, DateTime64(3, 'UTC'))
) ENGINE = AggregatingMergeTree
PARTITION BY project_id
ORDER BY (project_id, anonymous_id, user_id, trait_key);

-- String traits. `$identify` is the event_name the ingest path assigns to an
-- identify payload (see eventName() in packages/server/src/ingest/row.ts);
-- traits are carried in that row's `properties`.
CREATE MATERIALIZED VIEW IF NOT EXISTS person_traits_str_mv
TO person_traits AS
SELECT
  project_id,
  anonymous_id,
  user_id,
  kv.1 AS trait_key,
  argMaxState(kv.2, timestamp)               AS value_str,
  argMaxState(CAST(0, 'Float64'), timestamp) AS value_num,
  argMaxState(CAST(0, 'UInt8'), timestamp)   AS has_num
FROM events
ARRAY JOIN CAST(properties, 'Array(Tuple(String, String))') AS kv
WHERE event_name = '$identify'
GROUP BY project_id, anonymous_id, user_id, trait_key;

-- Numeric traits.
CREATE MATERIALIZED VIEW IF NOT EXISTS person_traits_num_mv
TO person_traits AS
SELECT
  project_id,
  anonymous_id,
  user_id,
  kv.1 AS trait_key,
  argMaxState(CAST('', 'String'), timestamp) AS value_str,
  argMaxState(kv.2, timestamp)               AS value_num,
  argMaxState(CAST(1, 'UInt8'), timestamp)   AS has_num
FROM events
ARRAY JOIN CAST(properties_num, 'Array(Tuple(String, Float64))') AS kv
WHERE event_name = '$identify'
GROUP BY project_id, anonymous_id, user_id, trait_key;
