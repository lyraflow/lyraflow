import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './index.js'

// This file used to assert `SCHEMA_VERSION` against a hardcoded number, which
// meant every migration had to edit it -- and it failed on the 014 migration
// for that reason and no other.
//
// It could not catch anything `packages/db/src/schema-version.test.ts` misses.
// That test derives the same fact from the migration files on disk
// (`SCHEMA_VERSION === max(migration versions)`), so:
//
//   migration added + constant bumped   -> derived passes;  hardcoded FAILED
//   constant bumped, no migration       -> derived fails;   hardcoded failed
//   migration added, constant not bumped-> derived FAILS;   hardcoded passed
//   neither                             -> both pass
//
// The only row where the hardcoded assertion fired alone is the row where the
// change was correct. It was a migration-checklist step wearing a test's
// clothing (#138).
//
// The file is kept rather than deleted because "core exports a schema version
// at all" is worth asserting, and `packages/core` cannot derive the number --
// reading the migration files is `packages/db`'s job and the dependency runs
// the other way. So this asserts the shape, and the value is pinned once, in
// the package that can actually check it.
describe('core', () => {
  it('exposes the app schema version as a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true)
    expect(SCHEMA_VERSION).toBeGreaterThan(0)
  })
})
