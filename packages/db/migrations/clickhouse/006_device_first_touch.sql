-- 006_device_first_touch: first-touch columns for the six context attributes
-- device_index previously recorded only as latest_*.
--
-- device_index stored first-touch values only for acquisition attributes
-- (referrer and the UTM trio), because those are the ones whose ORIGINAL
-- value is the interesting one. The segment compiler exposes a `first_touch`
-- scope for every context field, so the remaining six need a first-touch
-- aggregate of their own.
--
-- They cannot be derived from the latest_* columns. Those hold
-- AggregateFunction(argMax, ...) states, and an argMax state carries the
-- value at the LATEST timestamp only -- there is no way to read the earliest
-- observation back out of it. A separate argMin state is the only way to
-- answer "what was this when we first saw them".
--
-- Rows written before this migration read as empty for the new columns. That
-- is correct rather than merely tolerable: the value genuinely was never
-- recorded, and backfilling would require re-reading the whole events table
-- and would invent first-touch values for months whose events may already
-- have aged out under retention.
--
-- This migration is additive and does NOT amend 002_events.sql in place.
-- Editing 002 would leave every deployment that already applied it without
-- these columns, because migrate() skips versions already in the ledger, and
-- would put the materialised view's definition in two files at once.
ALTER TABLE device_index
  ADD COLUMN IF NOT EXISTS first_country AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
  ADD COLUMN IF NOT EXISTS first_region  AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
  ADD COLUMN IF NOT EXISTS first_city    AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
  ADD COLUMN IF NOT EXISTS first_device  AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
  ADD COLUMN IF NOT EXISTS first_os      AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
  ADD COLUMN IF NOT EXISTS first_browser AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC'));

-- A materialised view's SELECT cannot be altered in place, so the view is
-- dropped and recreated. Only the view definition is dropped -- device_index
-- itself is the TO target and keeps every row. The drop/create pair is
-- idempotent, which is what the migrator requires of a ClickHouse migration:
-- it has no cross-statement transaction, so a partial failure must be safe to
-- re-run.
--
-- Migrations run at boot before the server accepts traffic, so no insert can
-- land in the window where the view does not exist.
DROP TABLE IF EXISTS device_index_mv;

CREATE MATERIALIZED VIEW IF NOT EXISTS device_index_mv TO device_index AS
SELECT
  project_id,
  anonymous_id,
  user_id,
  toStartOfMonth(timestamp)               AS month,
  minState(timestamp)                     AS first_seen,
  maxState(timestamp)                     AS last_seen,
  countState()                            AS event_count,
  argMaxState(country, timestamp)         AS latest_country,
  argMaxState(region, timestamp)          AS latest_region,
  argMaxState(city, timestamp)            AS latest_city,
  argMaxState(device_type, timestamp)     AS latest_device,
  argMaxState(os, timestamp)              AS latest_os,
  argMaxState(browser, timestamp)         AS latest_browser,
  argMinState(referrer, timestamp)        AS first_referrer,
  argMinState(utm_source, timestamp)      AS first_source,
  argMinState(utm_medium, timestamp)      AS first_medium,
  argMinState(utm_campaign, timestamp)    AS first_campaign,
  argMinState(country, timestamp)         AS first_country,
  argMinState(region, timestamp)          AS first_region,
  argMinState(city, timestamp)            AS first_city,
  argMinState(device_type, timestamp)     AS first_device,
  argMinState(os, timestamp)              AS first_os,
  argMinState(browser, timestamp)         AS first_browser
FROM events
GROUP BY project_id, anonymous_id, user_id, month;
