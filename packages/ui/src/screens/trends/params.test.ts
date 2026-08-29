import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  breakdownIncomplete,
  groupByOf,
  hasTrendDefinitionParams,
  incompletePredicates,
  readTrendParams,
  writeTrendParams,
} from './params.js'

const read = (qs: string) => readTrendParams(new URLSearchParams(qs))

describe('readTrendParams', () => {
  it('reads a full definition', () => {
    expect(read('event=checkout&interval=1w&source=property&field=plan')).toEqual({
      ...DEFAULTS,
      event: 'checkout',
      interval: '1w',
      source: 'property',
      field: 'plan',
    })
  })

  it('falls back for anything unreadable, so a hand-edited link still opens', () => {
    expect(read('interval=1y').interval).toBe(DEFAULTS.interval)
    expect(read('source=trait').source).toBe(DEFAULTS.source)
  })
})

describe('writeTrendParams', () => {
  it('omits defaults, so the link stays readable', () => {
    expect(writeTrendParams(new URLSearchParams(), DEFAULTS).toString()).toBe('')
  })

  it('round-trips a chosen definition', () => {
    const chosen = {
      ...DEFAULTS,
      event: 'checkout',
      interval: '1h' as const,
      source: 'attribute' as const,
      field: 'utm_source',
    }
    expect(readTrendParams(writeTrendParams(new URLSearchParams(), chosen))).toEqual(chosen)
  })

  it('keeps parameters it does not own', () => {
    expect(writeTrendParams(new URLSearchParams('project=7'), DEFAULTS).get('project')).toBe('7')
  })
})

describe('groupByOf', () => {
  it('is undefined when nothing is split', () => {
    expect(groupByOf(DEFAULTS)).toBeUndefined()
  })

  it('sends the bare event_name the endpoint has always taken', () => {
    expect(groupByOf({ ...DEFAULTS, source: 'event_name' })).toBe('event_name')
  })

  it('builds the source:name form the server parses', () => {
    expect(groupByOf({ ...DEFAULTS, source: 'property', field: 'plan' })).toBe('property:plan')
    expect(groupByOf({ ...DEFAULTS, source: 'attribute', field: 'os' })).toBe('attribute:os')
  })

  it('sends nothing at all for a half-finished split, rather than a request the server refuses', () => {
    expect(groupByOf({ ...DEFAULTS, source: 'property', field: '' })).toBeUndefined()
    expect(breakdownIncomplete({ ...DEFAULTS, source: 'property', field: '' })).toBe(true)
    expect(breakdownIncomplete({ ...DEFAULTS, source: 'event_name' })).toBe(false)
  })
})

describe('trend where predicates', () => {
  const ONE = { property: 'path', operator: '=' as const, value: '/register' }

  it('reads a filter out of the URL', () => {
    expect(read(`event=$page&where=${encodeURIComponent(JSON.stringify([ONE]))}`).where).toEqual([
      ONE,
    ])
  })

  it('defaults to no filter', () => {
    expect(read('event=$page').where).toEqual([])
  })

  it('round-trips through write', () => {
    const p = { ...DEFAULTS, event: '$page', where: [ONE] }
    expect(readTrendParams(writeTrendParams(new URLSearchParams(), p))).toEqual(p)
  })

  it('writes no parameter when there is no filter', () => {
    expect(writeTrendParams(new URLSearchParams(), DEFAULTS).toString()).toBe('')
  })

  it('counts an unfinished predicate', () => {
    expect(
      incompletePredicates({ ...DEFAULTS, where: [{ property: '', operator: '=', value: '' }] }),
    ).toBe(1)
  })

  it('makes a link carrying only a filter count as a definition', () => {
    // Otherwise opening a saved report through such a link would seed the
    // stored definition OVER the filter the link was sent to show.
    expect(hasTrendDefinitionParams(new URLSearchParams('where=%5B%5D'))).toBe(true)
  })
})
