import { describe, expect, it } from 'vitest'
import type { RangeChoice } from './range.js'
import {
  AUTO,
  CUSTOM,
  DEFAULT_RANGE,
  RANGE_PRESETS,
  bucketsIn,
  rangeIncomplete,
  readRange,
  resolveRange,
  writeRange,
} from './range.js'

const NOW = new Date('2026-08-28T12:00:00.000Z')
const custom = (from: string, to: string): RangeChoice => ({ preset: CUSTOM, from, to })

describe('resolveRange', () => {
  it('sends NO bounds for the default, which is what both screens did before', () => {
    // `auto` is not a range. The server's per-resolution default is tuned and
    // worth keeping as the default rather than replaced by a fixed span.
    expect(resolveRange(DEFAULT_RANGE, NOW)).toEqual({})
    expect(resolveRange({ preset: AUTO, from: '', to: '' }, NOW)).toEqual({})
  })

  it('counts a preset back from now', () => {
    expect(resolveRange({ preset: '7d', from: '', to: '' }, NOW)).toEqual({
      since: '2026-08-21T12:00:00.000Z',
      until: '2026-08-28T12:00:00.000Z',
    })
  })

  it('reads custom dates as whole UTC days, with the end INCLUSIVE', () => {
    // Somebody picking 1-7 June means the whole of the 7th. Reading the
    // picker in local time would put an event in a different bucket from the
    // one its own label names, since both screens bucket in UTC.
    expect(resolveRange(custom('2026-06-01', '2026-06-07'), NOW)).toEqual({
      since: '2026-06-01T00:00:00.000Z',
      until: '2026-06-07T23:59:59.999Z',
    })
  })

  it('resolves NOTHING for a half-filled custom range', () => {
    // Resolving half of it would silently pair a chosen start with an
    // unchosen end. The screen says it is unfinished instead.
    expect(resolveRange(custom('2026-06-01', ''), NOW)).toEqual({})
    expect(resolveRange(custom('', '2026-06-07'), NOW)).toEqual({})
    expect(rangeIncomplete(custom('2026-06-01', ''))).toBe(true)
    expect(rangeIncomplete(custom('2026-06-01', '2026-06-07'))).toBe(false)
    expect(rangeIncomplete(DEFAULT_RANGE)).toBe(false)
  })

  it('refuses a backwards or unparseable custom range rather than inverting it', () => {
    expect(resolveRange(custom('2026-06-07', '2026-06-01'), NOW)).toEqual({})
    expect(resolveRange(custom('not-a-date', '2026-06-07'), NOW)).toEqual({})
  })
})

describe('readRange / writeRange', () => {
  it('round-trips a preset', () => {
    const out = writeRange(new URLSearchParams(), { preset: '90d', from: '', to: '' })
    expect(readRange(out).preset).toBe('90d')
  })

  it('writes nothing for the default, so an untouched screen keeps a clean address', () => {
    expect(writeRange(new URLSearchParams(), DEFAULT_RANGE).toString()).toBe('')
  })

  it('round-trips a custom range', () => {
    const chosen = custom('2026-06-01', '2026-06-07')
    expect(readRange(writeRange(new URLSearchParams(), chosen))).toEqual(chosen)
  })

  it('drops the two dates when the choice is not custom', () => {
    // Left behind they would be bounds in the URL that nothing reads, and
    // would reappear the moment somebody picked `custom` again.
    const withDates = writeRange(new URLSearchParams(), custom('2026-06-01', '2026-06-07'))
    const back = writeRange(withDates, { preset: '30d', from: '2026-06-01', to: '2026-06-07' })
    expect(back.get('from')).toBeNull()
    expect(back.get('to')).toBeNull()
  })

  it('falls back to the default for a preset it does not know', () => {
    expect(readRange(new URLSearchParams('range=last-fortnight')).preset).toBe(DEFAULT_RANGE.preset)
  })

  it('keeps parameters it does not own', () => {
    expect(writeRange(new URLSearchParams('event=x'), DEFAULT_RANGE).get('event')).toBe('x')
  })
})

describe('bucketsIn', () => {
  it('is null when the range is the server’s to pick', () => {
    expect(bucketsIn(DEFAULT_RANGE, 86_400_000, NOW)).toBeNull()
  })

  it('counts the buckets a pairing would produce', () => {
    // 30 days at one-minute resolution is 43,200 against a ceiling of 1000 --
    // the combination somebody builds by accident when span and resolution
    // are two independent choices.
    expect(bucketsIn({ preset: '30d', from: '', to: '' }, 60_000, NOW)).toBe(43_200)
    expect(bucketsIn({ preset: '30d', from: '', to: '' }, 86_400_000, NOW)).toBe(30)
  })
})

describe('RANGE_PRESETS', () => {
  it('starts with the default and ends with custom', () => {
    expect(RANGE_PRESETS[0]?.id).toBe(AUTO)
    expect(RANGE_PRESETS[RANGE_PRESETS.length - 1]?.id).toBe(CUSTOM)
  })

  it('has no duplicate ids', () => {
    const ids = RANGE_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
