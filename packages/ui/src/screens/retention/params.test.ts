import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  MAX_PERIODS,
  readRetentionParams,
  toRequest,
  writeRetentionParams,
} from './params.js'

const read = (qs: string) => readRetentionParams(new URLSearchParams(qs))
const write = (p: Parameters<typeof writeRetentionParams>[1]) =>
  writeRetentionParams(new URLSearchParams(), p).toString()

describe('readRetentionParams', () => {
  it('reads a full definition', () => {
    expect(read('start=signed_up&return=project_created&granularity=day&periods=12')).toEqual({
      ...DEFAULTS,
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
    expect(write({ ...DEFAULTS })).toBe('')
  })

  it('round-trips a chosen definition', () => {
    const chosen = {
      ...DEFAULTS,
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

describe('where predicates in the URL', () => {
  const WHERE = [
    {
      source: 'attribute' as const,
      attribute: 'path' as const,
      operator: '=' as const,
      value: '/',
    },
  ]

  it('round-trips a predicate list, so a shared link reproduces the same grid', () => {
    // The screen has no store; the URL IS its persistence. A predicate left
    // out of it would mean a link that silently rebuilds a DIFFERENT grid
    // from the one whoever shared it was looking at.
    const out = writeRetentionParams(new URLSearchParams(), { ...DEFAULTS, startWhere: WHERE })
    expect(readRetentionParams(out).startWhere).toEqual(WHERE)
  })

  it('keeps the two sides independent', () => {
    const out = writeRetentionParams(new URLSearchParams(), {
      ...DEFAULTS,
      startWhere: WHERE,
      returnWhere: [],
    })
    const back = readRetentionParams(out)
    expect(back.startWhere).toHaveLength(1)
    expect(back.returnWhere).toHaveLength(0)
  })

  it('writes nothing for an empty list, so an untouched screen has a clean address', () => {
    expect(writeRetentionParams(new URLSearchParams(), DEFAULTS).toString()).toBe('')
  })

  it('degrades to no predicates for anything it cannot validate', () => {
    // Reachable by hand-editing the address bar or truncating a pasted link.
    // Validated through core's own schema per element rather than trusted as
    // parsed JSON, so what survives is definitely compilable.
    expect(readRetentionParams(new URLSearchParams('start_where=not-json')).startWhere).toEqual([])
    expect(readRetentionParams(new URLSearchParams('start_where={}')).startWhere).toEqual([])
    expect(
      readRetentionParams(
        new URLSearchParams(`start_where=${encodeURIComponent('[{"operator":"???"}]')}`),
      ).startWhere,
    ).toEqual([])
  })

  it('keeps the valid members of a partly-broken list', () => {
    const mixed = JSON.stringify([WHERE[0], { nonsense: true }])
    const out = readRetentionParams(new URLSearchParams(`start_where=${encodeURIComponent(mixed)}`))
    expect(out.startWhere).toHaveLength(1)
  })
})

describe('toRequest', () => {
  it('omits an empty where list rather than sending []', () => {
    const body = toRequest(DEFAULTS)
    expect('start_where' in body).toBe(false)
  })

  it('sends the predicates when there are any', () => {
    const body = toRequest({
      ...DEFAULTS,
      startWhere: [{ property: 'p', operator: '=', value: 'x' }],
    })
    expect(body.start_where).toHaveLength(1)
  })
})
