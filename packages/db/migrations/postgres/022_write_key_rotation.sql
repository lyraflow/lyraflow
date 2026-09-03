-- 022_write_key_rotation: one previous write key per project, with an expiry.
--
-- A write key is public by construction (it ships in every instrumented
-- page), so it will eventually be pasted somewhere it should not be, and
-- until now the only remedy was a new project. Rotation replaces the key and
-- keeps the old one honoured for a grace period, so pages still serving the
-- previous snippet keep collecting until their caches turn over.
--
-- ONE previous key, not a list. Rotating again inside the grace retires the
-- older key at once. Two live keys is already the widest window an operator
-- should have to reason about, and a list would need its own pruning.
--
-- The CHECK keeps the pair honest: a previous key with no expiry would be a
-- second permanent key, and an expiry with no key is meaningless. The
-- partial unique index keeps a retired key from colliding with any other
-- project's live one; both are 128-bit random so this is belt and braces.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS previous_write_key            text,
  ADD COLUMN IF NOT EXISTS previous_write_key_expires_at timestamptz;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_previous_write_key_pair;
ALTER TABLE projects ADD CONSTRAINT projects_previous_write_key_pair
  CHECK ((previous_write_key IS NULL) = (previous_write_key_expires_at IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS projects_previous_write_key_key
  ON projects (previous_write_key) WHERE previous_write_key IS NOT NULL;
