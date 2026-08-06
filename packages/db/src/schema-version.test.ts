import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migrator.js'

/**
 * IMPORTANT 2 — read this before adding a migration.
 *
 * `SCHEMA_VERSION` is hand-maintained, and `migrate()` throws
 * `SchemaTooNewError` when the highest *applied* version exceeds it. Nothing
 * else in the suite ties the two together: `version.test.ts` asserts against
 * the constant itself, and both schema tests pass `appSchemaVersion: 999`.
 *
 * So adding `003_identity.sql` without bumping the constant used to pass CI
 * completely. The damage lands on the *operator*, one upgrade later: the first
 * boot applies 003 (the max is read before the loop runs), and the *second*
 * boot throws SchemaTooNewError. With `restart: unless-stopped` that is a crash
 * loop, triggered by an upgrade that ships after the mistake was made — the
 * exact class of surprise the "no version-specific runbooks" promise rules out.
 *
 * This test makes that mistake fail here instead, at the moment it is made.
 */
describe('SCHEMA_VERSION', () => {
  it('matches the highest migration version on disk', () => {
    const migrations = loadMigrations(join(import.meta.dirname, '..', 'migrations'))
    const highest = Math.max(...migrations.map((m) => m.version))

    expect(migrations.length).toBeGreaterThan(0)
    expect(SCHEMA_VERSION).toBe(highest)
  })
})
