import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_MAX_ENTRIES,
  CACHE_MAX_ROWS,
  CACHE_TTL_MS,
  type CachedResult,
  SegmentCache,
} from './cache.js'

const result = (rows = 0): CachedResult => ({
  count: rows,
  members: Array.from({ length: rows }, (_, i) => ({
    person_id: `p${i}`,
    first_seen: '2026-01-01 00:00:00.000',
    last_seen: '2026-01-02 00:00:00.000',
  })),
  asOf: '2026-08-07T00:00:00.000Z',
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SegmentCache', () => {
  it('returns what was stored', () => {
    const c = new SegmentCache()
    c.set('k', result(2))
    expect(c.get('k')?.count).toBe(2)
  })

  it('misses after the TTL', () => {
    const c = new SegmentCache()
    c.set('k', result())
    vi.advanceTimersByTime(CACHE_TTL_MS + 1)
    expect(c.get('k')).toBeUndefined()
  })

  it('evicts the least recently used entry past the entry cap', () => {
    const c = new SegmentCache()
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) c.set(`k${i}`, result())
    expect(c.size).toBeLessThanOrEqual(CACHE_MAX_ENTRIES)
    expect(c.get('k0')).toBeUndefined()
    expect(c.get(`k${CACHE_MAX_ENTRIES}`)).toBeDefined()
  })

  it('evicts on total rows even when the entry cap is not reached', () => {
    // The bound that actually matters. 200 entries of 1000 rows is ~200k rows
    // resident in a container that runs under a 512MB limit; the entry cap
    // alone does not bound memory. Plan 1's OOM was this exact shape — a
    // meticulously bounded buffer behind an unbounded cache.
    const c = new SegmentCache()
    const perEntry = 1000
    const entries = Math.ceil(CACHE_MAX_ROWS / perEntry) + 5
    for (let i = 0; i < entries; i++) c.set(`k${i}`, result(perEntry))
    expect(c.size).toBeLessThan(entries)
    expect(c.rows).toBeLessThanOrEqual(CACHE_MAX_ROWS)
  })

  it('refreshes recency on read, so a hot key is not evicted', () => {
    const c = new SegmentCache()
    c.set('hot', result())
    for (let i = 0; i < CACHE_MAX_ENTRIES - 1; i++) {
      c.set(`k${i}`, result())
      c.get('hot')
    }
    c.set('one-more', result())
    expect(c.get('hot')).toBeDefined()
  })

  it('never stores an entry larger than the whole budget', () => {
    const c = new SegmentCache()
    c.set('huge', result(CACHE_MAX_ROWS + 1))
    expect(c.rows).toBeLessThanOrEqual(CACHE_MAX_ROWS)
  })
})
