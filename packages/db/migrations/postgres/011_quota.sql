-- Quota enforcement, arriving in Plan 10. `monthly_event_quota` has existed
-- since 001_core.sql -- NOT NULL DEFAULT 50000000 -- loaded into ProjectCache
-- and acted on by nothing.
--
-- This migration REWRITES EXISTING ROWS, which the retention plan's own
-- migration was forbidden from doing. The direction is what makes it safe:
-- retention's forbidden UPDATE would have IMPOSED a limit nobody chose,
-- while this one REMOVES one. Starting to enforce the shipped 50,000,000
-- default would hand every existing project a hard cap it never opted into,
-- discovered by hitting it.
--
-- NULL means unlimited, and becomes the default for new projects too. An
-- operator who wants the protection sets a number.
ALTER TABLE projects ALTER COLUMN monthly_event_quota DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN monthly_event_quota DROP DEFAULT;
UPDATE projects SET monthly_event_quota = NULL;

-- Distinguishable from `events_throttled`, deliberately. Throttled means the
-- buffer was full: transient, retry shortly, the server is the constraint.
-- Over-quota means refused for the rest of the month: the configuration is
-- the constraint and retrying is pointless. An operator seeing a spike needs
-- to know which, because the responses are opposite.
ALTER TABLE ingest_counters ADD COLUMN IF NOT EXISTS events_over_quota bigint NOT NULL DEFAULT 0;
