import { describe, expect, it } from 'vitest'
import { DEFAULTS, MAX_PERIODS, readRetentionParams, writeRetentionParams } from './params.js'

const read = (qs: string) => readRetentionParams(new URLSearchParams(qs))
const write = (p: Parameters<typeof writeRetentionParams>[1]) =>
  writeRetentionParams(new URLSearchParams(), p).toString()

describe('readRetentionParams', () => {
  it('reads a full definition', () => {
    expect(read('start=signed_up&return=project_created&granularity=day&periods=12')).toEqual({
      start: 'signed_up',
      return: 'project_created',
      granularity: 'day',
      periods: 12,
    })
  })

  it('falls back to defaults for anything unreadable, rather than failing', () => {
    // A hand-edited or truncated link must open a usable screen. Every one of
    // these is reachable by someone editing the address bar.
    expect(read('granularity=fortnight').granularity).toBe(DEFAULTS.granularity)
    expect(read('periods=0').periods).toBe(DEFAULTS.periods)
    expect(read('periods=-3').periods).toBe(DEFAULTS.periods)
    expect(read('periods=2.5').periods).toBe(DEFAULTS.periods)
    expect(read('periods=abc').periods).toBe(DEFAULTS.periods)
  })

  it('refuses a period count past the cap the API enforces', () => {
    // The control must not be able to ask for a grid the server refuses.
    expect(read(`periods=${MAX_PERIODS + 1}`).periods).toBe(DEFAULTS.periods)
    expect(read(`periods=${MAX_PERIODS}`).periods).toBe(MAX_PERIODS)
  })
})

describe('writeRetentionParams', () => {
  it('omits anything that equals its default, so the link stays readable', () => {
    expect(write({ start: '', return: '', granularity: 'week', periods: 8 })).toBe('')
  })

  it('round-trips a chosen definition', () => {
    const chosen = {
      start: 'signed_up',
      return: 'project_created',
      granularity: 'month' as const,
      periods: 3,
    }
    expect(readRetentionParams(new URLSearchParams(write(chosen)))).toEqual(chosen)
  })

  it('keeps parameters it does not own', () => {
    const out = writeRetentionParams(new URLSearchParams('project=7'), DEFAULTS)
    expect(out.get('project')).toBe('7')
  })
})
