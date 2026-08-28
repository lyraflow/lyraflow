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
    identified: false,
    traits: {},
    traits_num: {},
    trait_total: 0,
  })),
  asOf: '2026-08-07T00:00:00.000Z',
})

// An arbitrary, fixed project id most tests below don't care about — they
// exercise eviction/TTL/LRU behaviour that is orthogonal to which project a
// key belongs to. `clearProject`/generation tests use their own explicit
// ids instead, since project identity is exactly what those are about.
const PROJECT = 1

/**
 * `set()` now takes `projectId`/`generation` (see cache.ts's own docstring
 * for why) — this captures "the current generation, right now" the same way
 * routes.ts's `runTree` does, for tests that aren't exercising the race
 * those two parameters exist to close.
 */
function setFresh(c: SegmentCache, key: string, value: CachedResult, projectId = PROJECT): void {
  c.set(key, value, projectId, c.generation(projectId))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SegmentCache', () => {
  it('returns what was stored', () => {
    const c = new SegmentCache()
    setFresh(c, 'k', result(2))
    expect(c.get('k')?.count).toBe(2)
  })

  it('misses after the TTL', () => {
    const c = new SegmentCache()
    setFresh(c, 'k', result())
    vi.advanceTimersByTime(CACHE_TTL_MS + 1)
    expect(c.get('k')).toBeUndefined()
  })

  it('evicts the least recently used entry past the entry cap', () => {
    const c = new SegmentCache()
    for (let i = 0; i <= CACHE_MAX_ENTRIES; i++) setFresh(c, `k${i}`, result())
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
    for (let i = 0; i < entries; i++) setFresh(c, `k${i}`, result(perEntry))
    expect(c.size).toBeLessThan(entries)
    expect(c.rows).toBeLessThanOrEqual(CACHE_MAX_ROWS)
  })

  it('evicts least-recently-used first when the ROW bound is what trips', () => {
    // 1000 rows per entry means the row bound trips around entry 50, while the
    // 200-entry cap is never approached — so this exercises row-driven
    // eviction on its own, one entry at a time rather than via the entry-cap
    // path.
    const c = new SegmentCache()
    const perEntry = 1000
    const capEntries = CACHE_MAX_ROWS / perEntry // exact: 50 entries fit the row budget
    const entries = capEntries + 5
    for (let i = 0; i < entries; i++) setFresh(c, `k${i}`, result(perEntry))

    // Under one-at-a-time LRU eviction, exactly `entries - capEntries` of the
    // oldest keys are gone and the rest survive untouched — so the oldest
    // *surviving* key is `k${survivorStart}`. A cache that instead wipes
    // itself whenever a bound trips would still show k0 gone and the newest
    // key present (this happens to be the last thing added, in both models);
    // checking the oldest surviving key is what actually tells eviction-by-
    // recency apart from eviction-by-clearing-everything.
    const survivorStart = entries - capEntries
    expect(c.size).toBeLessThan(CACHE_MAX_ENTRIES) // the entry cap did NOT trip
    expect(c.rows).toBeLessThanOrEqual(CACHE_MAX_ROWS)
    expect(c.get('k0')).toBeUndefined() // oldest gone
    expect(c.get(`k${survivorStart - 1}`)).toBeUndefined() // still within the evicted range
    expect(c.get(`k${survivorStart}`)).toBeDefined() // oldest surviving key
    expect(c.get(`k${entries - 1}`)).toBeDefined() // newest kept
  })

  it('refreshes recency on read, so a hot key is not evicted', () => {
    const c = new SegmentCache()
    setFresh(c, 'hot', result())
    for (let i = 0; i < CACHE_MAX_ENTRIES - 1; i++) {
      setFresh(c, `k${i}`, result())
      c.get('hot')
    }
    setFresh(c, 'one-more', result())
    expect(c.get('hot')).toBeDefined()
  })

  it('never stores an entry larger than the whole budget', () => {
    const c = new SegmentCache()
    setFresh(c, 'huge', result(CACHE_MAX_ROWS + 1))
    expect(c.rows).toBeLessThanOrEqual(CACHE_MAX_ROWS)
  })

  describe('clearProject', () => {
    it('drops every entry for the given project, regardless of TTL', () => {
      const c = new SegmentCache()
      setFresh(c, '1:count:abc', result(2), 1)
      setFresh(c, '1:members::abc', result(2), 1)
      c.clearProject(1)
      expect(c.get('1:count:abc')).toBeUndefined()
      expect(c.get('1:members::abc')).toBeUndefined()
    })

    it("does not touch another project's entries", () => {
      const c = new SegmentCache()
      setFresh(c, '1:count:abc', result(2), 1)
      setFresh(c, '2:count:abc', result(3), 2)
      c.clearProject(1)
      expect(c.get('1:count:abc')).toBeUndefined()
      expect(c.get('2:count:abc')?.count).toBe(3)
    })

    it('is a no-op when the project has nothing cached', () => {
      const c = new SegmentCache()
      setFresh(c, '2:count:abc', result(3), 2)
      expect(() => c.clearProject(1)).not.toThrow()
      expect(c.get('2:count:abc')?.count).toBe(3)
    })

    it('correctly accounts the row budget after clearing', () => {
      // clearProject drops entries through the same #drop() path set()/get()
      // use, not a separate deletion — this pins that the shared #rows
      // accounting stays correct rather than double-counting or leaking rows
      // that a later evict() would then trip on for the wrong reason.
      const c = new SegmentCache()
      setFresh(c, '1:count:abc', result(1000), 1)
      c.clearProject(1)
      expect(c.rows).toBe(0)
    })

    it("does not affect another project's generation", () => {
      const c = new SegmentCache()
      const before = c.generation(2)
      c.clearProject(1)
      expect(c.generation(2)).toBe(before)
    })
  })

  describe('generation (the race between a DELETE and an in-flight preview)', () => {
    // The ordering, not a timing test: a query "far enough along to have its
    // rows" is modelled by capturing the generation FIRST, exactly as
    // routes.ts's runTree does, with the actual query work (which this unit
    // test has no ClickHouse to run) standing in as "time passes here, then
    // the caller finally reaches its own set() call".
    it('discards a set() whose generation was captured before an intervening clearProject()', () => {
      const c = new SegmentCache()
      const projectId = 7
      // The preview captures the generation BEFORE issuing its query...
      const generationAtQueryStart = c.generation(projectId)
      // ...a DELETE's invalidation lands while that query is still running...
      c.clearProject(projectId)
      // ...and only THEN does the preview's query resolve and reach set(),
      // carrying the now-stale generation it captured at the start.
      c.set(`${projectId}:members::abc`, result(1), projectId, generationAtQueryStart)

      // Without the generation check this entry would be present — this is
      // exactly the entry `clearProject()` alone cannot reach, because it
      // did not exist yet at the moment `clearProject()` ran.
      expect(c.get(`${projectId}:members::abc`)).toBeUndefined()
    })

    it('still stores a set() whose generation matches the current one', () => {
      // The positive case, so the test above is pinned on the RACE, not on
      // set() having quietly stopped storing anything at all.
      const c = new SegmentCache()
      const projectId = 8
      const generation = c.generation(projectId)
      c.set(`${projectId}:count:abc`, result(2), projectId, generation)
      expect(c.get(`${projectId}:count:abc`)?.count).toBe(2)
    })

    it('accepts a fresh query issued AFTER the clearProject(), under the new generation', () => {
      const c = new SegmentCache()
      const projectId = 9
      c.clearProject(projectId)
      // A caller starting a NEW query only after the clear naturally
      // captures the NEW generation, and its write must land normally —
      // clearProject() is not a permanent poison pill for the project.
      const freshGeneration = c.generation(projectId)
      c.set(`${projectId}:count:abc`, result(5), projectId, freshGeneration)
      expect(c.get(`${projectId}:count:abc`)?.count).toBe(5)
    })
  })
})
