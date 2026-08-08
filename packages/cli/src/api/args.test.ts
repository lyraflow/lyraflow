import { describe, expect, it } from 'vitest'
import { UsageError, parseCommandArgs, parseDuration, resolveInstant } from './args.js'

describe('parseDuration', () => {
  it('parses minutes, hours and days into milliseconds', () => {
    expect(parseDuration('15m')).toBe(15 * 60_000)
    expect(parseDuration('24h')).toBe(24 * 60 * 60_000)
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60_000)
  })

  it('rejects anything that is not exactly digits + m|h|d', () => {
    for (const bad of ['', '15', '15w', '1.5h', ' 15m', '15m ', '-5m']) {
      expect(() => parseDuration(bad)).toThrow(UsageError)
    }
  })
})

describe('resolveInstant', () => {
  it('reads a relative duration as an offset from now', () => {
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('15m', now).toISOString()).toBe('2026-08-08T11:45:00.000Z')
    expect(resolveInstant('24h', now).toISOString()).toBe('2026-08-07T12:00:00.000Z')
    expect(resolveInstant('7d', now).toISOString()).toBe('2026-08-01T12:00:00.000Z')
  })

  it('accepts an absolute ISO instant unchanged', () => {
    // What an agent generates. Rejecting it would force every caller to compute
    // a duration from a timestamp it already holds.
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('2026-08-01T00:00:00.000Z', now).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    )
  })

  it('rejects nonsense with a usage error, not a silent default', () => {
    // A bad --since that quietly became "15 minutes ago" would answer a
    // question nobody asked, and look like real data.
    for (const bad of ['', '15', 'm15', '15x', 'yesterday', '-5m', 'NaN']) {
      expect(() => resolveInstant(bad, new Date())).toThrow(UsageError)
    }
  })

  it('rejects everything Date.parse is loose about that is not real ISO 8601', () => {
    // Date.parse (V8) happily accepts a bare year, a non-ISO human date, and
    // (separately) a shape-valid-but-impossible calendar date. All three
    // would otherwise resolve to *some* instant and look like real data.
    const now = new Date('2026-08-08T12:00:00.000Z')
    for (const bad of ['2026', '2026-08', 'Aug 1 2026', '2026-13-45T00:00:00Z', '15m ']) {
      expect(() => resolveInstant(bad, now)).toThrow(UsageError)
    }
  })

  it('accepts a bare ISO date as midnight UTC', () => {
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('2026-08-01', now).toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it("rejects a duration whose offset overflows Date's representable range, with UsageError not a crash", () => {
    // DURATION_RE has no digit cap: "999999999d" is shape-valid but the
    // resulting offset falls outside Date's +-8.64e15ms range. `new Date`
    // on that doesn't throw -- it returns an Invalid Date whose .getTime()
    // is NaN, and the RangeError would otherwise only surface later, in
    // whatever caller first calls .toISOString() (every caller).
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(() => resolveInstant('999999999d', now)).toThrow(UsageError)
  })

  it('accepts a merely absurd but still in-range duration', () => {
    // The boundary is Date's representable range, not "a big number" --
    // this pins that a large-but-valid duration is NOT rejected, so the
    // overflow test above is proven against the real boundary rather than
    // an arbitrary size cutoff.
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('36500d', now).toISOString()).toBe('1926-09-02T12:00:00.000Z')
  })

  it('rejects a calendar date that Date.parse would silently roll over to a different real date', () => {
    // Date.parse (and Date.UTC) do not reject an out-of-range day/month --
    // they roll it forward into the next one. A shape match against
    // ISO_INSTANT_RE alone does not catch this; only round-tripping the
    // typed digits does.
    const now = new Date('2026-08-08T12:00:00.000Z')
    for (const bad of [
      '2026-02-30', // rolls to 2026-03-02
      '2026-02-30T00:00:00Z', // same, with a time component
      '2026-04-31', // April has 30 days; rolls to 2026-05-01
      '2025-02-29', // 2025 is not a leap year; rolls to 2025-03-01
    ]) {
      expect(() => resolveInstant(bad, now)).toThrow(UsageError)
    }
  })

  it('still accepts every previously-supported ISO form after the round-trip check', () => {
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('2026-08-01T00:00:00.000Z', now).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    )
    expect(resolveInstant('2026-08-01', now).toISOString()).toBe('2026-08-01T00:00:00.000Z')
    // Fractional seconds.
    expect(resolveInstant('2026-08-01T12:34:56.789Z', now).toISOString()).toBe(
      '2026-08-01T12:34:56.789Z',
    )
    // A non-Z offset, which legitimately shifts the calendar day in UTC --
    // that's a correct conversion, not a near-miss to reject.
    expect(resolveInstant('2026-08-01T01:00:00+05:30', now).toISOString()).toBe(
      '2026-07-31T19:30:00.000Z',
    )
  })

  it('accepts a four-digit year below 100, which Date.UTC would read as 19xx', () => {
    // Date.UTC(50, 0, 1) means 1950, not year 50 -- the legacy two-digit-year
    // rule applies to the NUMERIC argument, so the round-trip check would
    // compare 1950 against the typed 50 and reject a well-formed ISO date.
    // Absurd as a --since, but the round-trip must reject wrong dates, not
    // merely unlikely ones.
    const now = new Date('2026-08-08T12:00:00.000Z')
    expect(resolveInstant('0050-01-01', now).toISOString()).toBe('0050-01-01T00:00:00.000Z')
    expect(resolveInstant('0099-06-15T12:00:00Z', now).toISOString()).toBe(
      '0099-06-15T12:00:00.000Z',
    )
    // And it still rejects an impossible date in that range.
    expect(() => resolveInstant('0050-02-30', now)).toThrow(UsageError)
  })
})

const SPEC = { strings: ['since', 'event'], booleans: ['follow', 'json'] }

describe('parseCommandArgs', () => {
  it('splits positionals from flags, string and boolean alike', () => {
    const result = parseCommandArgs(['get', 'user-42', '--since', '15m', '--json'], SPEC)
    expect(result).toEqual({
      flags: { since: '15m', json: true },
      positionals: ['get', 'user-42'],
    })
  })

  it('leaves an unset boolean absent rather than defaulting it to false', () => {
    const result = parseCommandArgs(['--json'], SPEC)
    expect(Object.hasOwn(result.flags, 'follow')).toBe(false)
  })

  it('rejects an unknown flag with a usage error rather than ignoring it', () => {
    expect(() => parseCommandArgs(['--wat', 'x'], SPEC)).toThrow(UsageError)
  })

  it('rejects an ambiguous option value (a flag swallowing the next flag)', () => {
    expect(() => parseCommandArgs(['--since', '--json'], SPEC)).toThrow(UsageError)
  })

  it('rejects a value attached to a boolean flag', () => {
    expect(() => parseCommandArgs(['--json=false'], SPEC)).toThrow(UsageError)
  })
})
