import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CARRIES_A_ZONE, lifecycleInstant } from './instants.js'

/**
 * **Every assertion here is meaningless in UTC**, which is the coincidence
 * that let the defect live: where the process zone IS UTC, reading a zone-less
 * value as local and reading it as UTC agree on every fixture, so an identity
 * function and a correct one are indistinguishable. The zone is stubbed, and
 * the first test asserts the stub took.
 */
const ZONE = 'Asia/Kolkata'

describe('lifecycleInstant', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', ZONE)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is running somewhere that is not UTC, so a wrong reading is observable', () => {
    expect(new Date('2026-08-01T10:00:00').getTimezoneOffset()).not.toBe(0)
  })

  it("reads a zone-less date-time as UTC, not as the server's zone", () => {
    // The defect (#124). `new Date('2026-08-01T10:00')` resolves in the
    // RUNTIME's zone, so the same stored segment meant a different instant on
    // a server in Berlin than on one in São Paulo -- and moving a deployment,
    // or a container picking up a different TZ, silently changed which people
    // it matched.
    expect(lifecycleInstant('2026-08-01T10:00').toISOString()).toBe('2026-08-01T10:00:00.000Z')
    expect(new Date('2026-08-01T10:00').toISOString()).not.toBe('2026-08-01T10:00:00.000Z')
  })

  it('keeps seconds and milliseconds on a zone-less reading', () => {
    expect(lifecycleInstant('2026-08-01T10:00:07.250').toISOString()).toBe(
      '2026-08-01T10:00:07.250Z',
    )
  })

  it('leaves a value that already carries a zone alone', () => {
    expect(lifecycleInstant('2026-08-01T10:00:00Z').toISOString()).toBe('2026-08-01T10:00:00.000Z')
    // An OFFSET, not just `Z`. This is the shape the regex's `[+-]\d{2}:?\d{2}`
    // half exists for, and reading it as UTC would shift it by that offset.
    expect(lifecycleInstant('2026-08-01T10:00:00+05:30').toISOString()).toBe(
      '2026-08-01T04:30:00.000Z',
    )
  })

  it('resolves a BARE DATE as UTC midnight, which the language already does', () => {
    // Called out because it is the one shape where the plain `new Date` was
    // ALREADY right: the spec resolves a date-only form as UTC and a
    // date-time form as local. That inconsistency is why this is a function
    // rather than a rule of thumb about appending a `Z`.
    expect(lifecycleInstant('2026-08-01').toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(new Date('2026-08-01').toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('returns an Invalid Date rather than throwing, exactly as new Date does', () => {
    // The schema's refine is what rejects these. This must not start throwing
    // where the compiler previously produced a value.
    expect(Number.isNaN(lifecycleInstant('soon').getTime())).toBe(true)
    expect(Number.isNaN(lifecycleInstant('').getTime())).toBe(true)
  })
})

describe('CARRIES_A_ZONE', () => {
  it('classifies every shape the schema accepts', () => {
    // Note what this does NOT claim. The leading `T` in the expression was
    // described as load-bearing; removing it was mutation-tested and nothing
    // failed, because `-08-01` cannot match `[+-]\d{2}:?\d{2}$` anyway --
    // after `-08` the pattern needs two more digits and finds a `-`. The
    // anchor is readability, and the comment in `instants.ts` now says so.
    //
    // What is pinned is the classification itself, which the whole rule
    // depends on: get one of these wrong and a bound is silently shifted.
    expect(CARRIES_A_ZONE.test('2026-08-01')).toBe(false)
    expect(CARRIES_A_ZONE.test('2026-08-01T10:00')).toBe(false)
    expect(CARRIES_A_ZONE.test('2026-08-01T10:00Z')).toBe(true)
    expect(CARRIES_A_ZONE.test('2026-08-01T10:00+05:30')).toBe(true)
    expect(CARRIES_A_ZONE.test('2026-08-01T10:00-0800')).toBe(true)
  })
})
