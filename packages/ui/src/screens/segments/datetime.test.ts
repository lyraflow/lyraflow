import { Lifecycle, Window } from '@lyraflow/core/segments/ast.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { datetimeLocal, localZone, toInstant, toPickerValue } from './datetime.js'

/**
 * **This suite is meaningless in UTC**, and the machine it was written on
 * runs its container in UTC, which is exactly the coincidence point that
 * hides a missing conversion: where local IS UTC, an identity function and a
 * correct one agree on every fixture.
 *
 * Nothing in `vite.config.ts` pins `TZ`, so it is pinned here instead --
 * `+05:30`, which is neither zero nor a whole number of hours, so a
 * conversion that drops the minutes is caught as well as one that drops the
 * offset. It is unstubbed afterwards because a worker process is shared
 * between test files, and the first test below asserts the stub actually took
 * effect rather than trusting that it did -- if it silently did not, every
 * other test here would pass in UTC while proving nothing.
 *
 * The times are chosen the same way. `10:00` local is `04:30` UTC -- a
 * different hour AND a different minute -- and `02:00` local on the 1st is
 * `20:30` UTC on the PREVIOUS day of the PREVIOUS month, so a conversion that
 * gets the clock right and the date wrong cannot pass either. Midnight is
 * avoided deliberately: it is the one time of day where a date-only
 * comparison would look right.
 */
const ZONE = 'Asia/Kolkata'
const LOCAL_MIDMORNING = '2026-08-01T10:00'
const INSTANT_MIDMORNING = '2026-08-01T04:30:00.000Z'
const LOCAL_EARLY = '2026-08-01T02:00'
const INSTANT_EARLY = '2026-07-31T20:30:00.000Z'

// Through `vi.stubEnv`/`vi.unstubAllEnvs` rather than by assigning
// `process.env.TZ` directly: this package has no `@types/node`, so `process`
// is not a name `tsc` knows here, and CI runs `typecheck` before the suite.
// The assignment underneath is the same one, and Node re-reads `TZ` on the
// next `Date` -- the assertion immediately below is what proves it took
// effect rather than assuming it did.
beforeAll(() => {
  vi.stubEnv('TZ', ZONE)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('the test fixtures themselves', () => {
  it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
    expect(new Date(LOCAL_MIDMORNING).toISOString()).toBe(INSTANT_MIDMORNING)
    expect(new Date(LOCAL_MIDMORNING).getTimezoneOffset()).not.toBe(0)
  })
})

describe('toInstant -- picker reading to stored instant', () => {
  it('converts a local wall-clock reading to the UTC instant it names', () => {
    expect(toInstant(LOCAL_MIDMORNING)).toBe(INSTANT_MIDMORNING)
  })

  it('carries a reading over a day and month boundary', () => {
    expect(toInstant(LOCAL_EARLY)).toBe(INSTANT_EARLY)
  })

  it('produces a value the AST actually accepts, which the raw picker value is not', () => {
    // The defect, stated against the real schema rather than described. The
    // picker's own format has never once produced a saveable absolute
    // window; asserting only "the string changed" would not have caught a
    // conversion to some other rejected shape (an offset form, say, which
    // zod's `.datetime()` also refuses).
    const raw = Window.safeParse({
      kind: 'absolute',
      from: LOCAL_MIDMORNING,
      to: LOCAL_MIDMORNING,
    })
    expect(raw.success).toBe(false)
    const converted = Window.safeParse({
      kind: 'absolute',
      from: toInstant(LOCAL_MIDMORNING),
      to: toInstant(LOCAL_EARLY),
    })
    expect(converted.success).toBe(true)
  })

  it('leaves an empty reading empty rather than inventing "now"', () => {
    expect(toInstant('')).toBe('')
  })

  it('returns an unparseable reading unchanged rather than blanking it', () => {
    expect(toInstant('2026-13-99T99:99')).toBe('2026-13-99T99:99')
  })
})

describe('toPickerValue -- stored instant to picker reading', () => {
  it('converts a stored UTC instant back to the local wall-clock the picker shows', () => {
    expect(toPickerValue(INSTANT_MIDMORNING)).toBe(LOCAL_MIDMORNING)
  })

  it('carries an instant back over a day and month boundary', () => {
    expect(toPickerValue(INSTANT_EARLY)).toBe(LOCAL_EARLY)
  })

  it('accepts an offset form too, not only `Z`', () => {
    // `Window` refuses these, but `Lifecycle`'s looser refine does not, and
    // a stored tree can be authored through the API or CLI rather than this
    // screen.
    expect(toPickerValue('2026-08-01T00:00:00-04:30')).toBe(LOCAL_MIDMORNING)
  })

  it('passes a zone-less reading through UNSHIFTED, since it names no instant to convert', () => {
    // Load-bearing, not tidiness. `Lifecycle` stores exactly this shape
    // (verified below), so a blanket UTC-to-local conversion here would move
    // every stored lifecycle bound by the local offset the first time its
    // row rendered -- five and a half hours, on this fixture.
    expect(toPickerValue(LOCAL_MIDMORNING)).toBe(LOCAL_MIDMORNING)
  })

  it('leaves an empty value empty', () => {
    expect(toPickerValue('')).toBe('')
  })
})

describe('the round trip', () => {
  it('returns a reading to the picker unchanged, through a stored instant', () => {
    for (const local of [LOCAL_MIDMORNING, LOCAL_EARLY, '2026-12-31T23:59', '2026-01-01T00:01']) {
      expect(toPickerValue(toInstant(local))).toBe(local)
    }
  })

  it('is idempotent in both directions, so a conversion applied twice cannot corrupt', () => {
    expect(toInstant(toInstant(LOCAL_MIDMORNING))).toBe(INSTANT_MIDMORNING)
    expect(toPickerValue(toPickerValue(INSTANT_MIDMORNING))).toBe(LOCAL_MIDMORNING)
  })
})

describe('datetimeLocal', () => {
  it('renders a Date in the picker format, in LOCAL time', () => {
    expect(datetimeLocal(new Date(INSTANT_MIDMORNING))).toBe(LOCAL_MIDMORNING)
  })

  it('zero-pads every field, so a single-digit month or minute is still valid', () => {
    expect(datetimeLocal(new Date('2026-01-02T03:04:00+05:30'))).toBe('2026-01-02T03:04')
  })
})

describe('localZone', () => {
  it('reports the runtime zone rather than a guess', () => {
    // Compared against the runtime's own answer, never a literal: a host
    // resolves `Asia/Kolkata` to `Asia/Calcutta`, the same zone under an
    // older name, and hard-coding either makes this fail on the other.
    expect(localZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(localZone()).not.toBe('')
  })
})

/**
 * The question that had to be answered before assuming `LifecycleForm` was
 * broken the same way, kept as a test rather than as a note, so the answer
 * cannot go stale silently: `Lifecycle`'s refine is looser than the
 * `absolute` window's `.datetime()`, and accepts the picker's own zone-less
 * format. That is why lifecycle is left storing wall-clock readings and the
 * window is not -- and why `toPickerValue` must pass a zone-less value
 * through untouched.
 */
describe('why the lifecycle field is not converted the same way', () => {
  const lifecycle = (value: string) =>
    Lifecycle.safeParse({ kind: 'lifecycle', field: 'first_seen', operator: '>=', value })

  it("accepts the picker's own zone-less format, unlike an absolute window's bounds", () => {
    expect(lifecycle(LOCAL_MIDMORNING).success).toBe(true)
    expect(
      Window.safeParse({ kind: 'absolute', from: LOCAL_MIDMORNING, to: LOCAL_MIDMORNING }).success,
    ).toBe(false)
  })

  it('still refuses a value that is not a datetime at all', () => {
    expect(lifecycle('yesterday').success).toBe(false)
    expect(lifecycle('').success).toBe(false)
  })
})
