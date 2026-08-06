-- 002_events: the append-only events table, its dead-letter sibling, and the
-- device_index / event_schema derived structures. device_index and
-- event_schema are materialized views over `events` and must exist from the
-- very first insert -- a view added later would never see historical rows.

CREATE TABLE IF NOT EXISTS events (
  project_id     UInt32,
  event_id       UUID,
  anonymous_id   String,
  user_id        String,
  event_name     LowCardinality(String),
  timestamp      DateTime64(3, 'UTC'),
  received_at    DateTime64(3, 'UTC'),
  trusted        UInt8 DEFAULT 0,
  properties     Map(String, String),
  properties_num Map(String, Float64),
  url            String DEFAULT '',
  path           String DEFAULT '',
  referrer       String DEFAULT '',
  utm_source     LowCardinality(String) DEFAULT '',
  utm_medium     LowCardinality(String) DEFAULT '',
  utm_campaign   String DEFAULT '',
  utm_term       String DEFAULT '',
  utm_content    String DEFAULT '',
  device_type    LowCardinality(String) DEFAULT '',
  os             LowCardinality(String) DEFAULT '',
  browser        LowCardinality(String) DEFAULT '',
  country        LowCardinality(String) DEFAULT '',
  region         String DEFAULT '',
  city           String DEFAULT '',
  INDEX idx_anon  anonymous_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_event event_name   TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree(received_at)
PARTITION BY (project_id, toYYYYMM(timestamp))
ORDER BY (project_id, timestamp, anonymous_id, event_id);

CREATE TABLE IF NOT EXISTS events_dead_letter (
  project_id   UInt32,
  received_at  DateTime64(3, 'UTC'),
  reason       LowCardinality(String),
  detail       String,
  payload      String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (project_id, received_at)
TTL toDateTime(received_at) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS device_index (
  project_id     UInt32,
  anonymous_id   String,
  user_id        String,
  month          Date,
  first_seen     AggregateFunction(min, DateTime64(3, 'UTC')),
  last_seen      AggregateFunction(max, DateTime64(3, 'UTC')),
  event_count    AggregateFunction(count),
  latest_country AggregateFunction(argMax, LowCardinality(String), DateTime64(3, 'UTC')),
  latest_region  AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  latest_city    AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  latest_device  AggregateFunction(argMax, LowCardinality(String), DateTime64(3, 'UTC')),
  latest_os      AggregateFunction(argMax, LowCardinality(String), DateTime64(3, 'UTC')),
  latest_browser AggregateFunction(argMax, LowCardinality(String), DateTime64(3, 'UTC')),
  first_referrer AggregateFunction(argMin, String, DateTime64(3, 'UTC')),
  first_source   AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
  first_medium   AggregateFunction(argMin, LowCardinality(String), DateTime64(3, 'UTC')),
  first_campaign AggregateFunction(argMin, String, DateTime64(3, 'UTC'))
) ENGINE = AggregatingMergeTree
PARTITION BY (project_id, toYYYYMM(month))
ORDER BY (project_id, anonymous_id, user_id, month);

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
  argMinState(utm_campaign, timestamp)    AS first_campaign
FROM events
GROUP BY project_id, anonymous_id, user_id, month;

CREATE TABLE IF NOT EXISTS event_schema (
  project_id   UInt32,
  event_name   LowCardinality(String),
  property_key String,
  value_kind   LowCardinality(String),
  last_seen    DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree(last_seen)
ORDER BY (project_id, event_name, property_key, value_kind);

-- ClickHouse rejects UNION ALL inside a materialized view (QUERY_IS_NOT_SUPPORTED_IN_MATERIALIZED_VIEW),
-- so the string-keyed and number-keyed property maps are split into two views
-- that both write to the same `event_schema` target table.
CREATE MATERIALIZED VIEW IF NOT EXISTS event_schema_str_mv TO event_schema AS
SELECT project_id, event_name, key AS property_key, 'string' AS value_kind, timestamp AS last_seen
FROM events ARRAY JOIN mapKeys(properties) AS key;

CREATE MATERIALIZED VIEW IF NOT EXISTS event_schema_num_mv TO event_schema AS
SELECT project_id, event_name, key AS property_key, 'number' AS value_kind, timestamp AS last_seen
FROM events ARRAY JOIN mapKeys(properties_num) AS key;
