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
