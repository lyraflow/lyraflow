-- 015_ingest_bot_counter: bot drops get their own column.
--
-- Until now a bot drop recorded `rejected`, the same bucket as a validation
-- failure and a limit rejection. An operator could see that events were
-- refused and not that they were refused AS BOTS -- so "is my integration
-- broken, or is that just crawler traffic" had no answer in the data.
--
-- That question stops being academic once server-side SDKs exist: an SDK
-- whose events are being dropped looks exactly like one sending bad data.
--
-- Additive, with a default, exactly as 011 added events_over_quota: existing
-- rows get 0 and no backfill is possible or wanted -- the drops that already
-- happened were never distinguished and inventing a number for them would be
-- worse than the honest zero.

ALTER TABLE ingest_counters ADD COLUMN IF NOT EXISTS events_bot bigint NOT NULL DEFAULT 0;
