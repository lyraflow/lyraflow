import { createPgPool } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isOverQuota } from '../ingest/quota.js'
import { MAX_NEGATIVE_ENTRIES, ProjectCache, hashServerKey } from './project-cache.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const SLUGS = ['cache-test', 'cache-test-unlimited']

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [SLUGS])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, monthly_event_quota)
     VALUES ('Cache Test', 'cache-test', 'wk_cache', $1, 1000)`,
    [hashServerKey('sk_cache')],
  )
  // The ordinary state of every project after migration 011, and therefore
  // the row shape the cache reads on every existing deployment — the one the
  // fixture above (an explicit quota) does not exercise at all.
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, monthly_event_quota)
     VALUES ('Cache Unlimited', 'cache-test-unlimited', 'wk_cache_unlimited', 'h', NULL)`,
  )
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [SLUGS])
  await pg.end()
})

describe('ProjectCache', () => {
  it('resolves a project by write key', async () => {
    const c = new ProjectCache(pg, 60_000)
    const p = await c.byWriteKey('wk_cache')
    expect(p).toMatchObject({ slug: 'cache-test', monthlyEventQuota: 1000 })
  })

  it('reads a NULL quota back as null, not as zero', async () => {
    // `Number(null)` is `0`, so the obvious parse turns "unlimited" into
    // "quota of zero" — and 011 made NULL the value EVERY existing project
    // carries, so this is not an edge case but the default state of every
    // deployment. Nothing else in the suite reads a NULL-quota project.
    const c = new ProjectCache(pg, 60_000)
    const p = await c.byWriteKey('wk_cache_unlimited')
    expect(p?.monthlyEventQuota).toBeNull()
    // The consequence, stated end to end rather than left implied: the
    // quota decision short-circuits on null and *throws* on 0, so the wrong
    // parse is a thrown error on every event of every unlimited project,
    // not a silently generous limit.
    expect(() => isOverQuota(0, 0, p?.monthlyEventQuota ?? null)).not.toThrow()
    expect(isOverQuota(0, 0, p?.monthlyEventQuota ?? null)).toBe(false)
  })

  it('reads a set quota back as a number, since pg returns bigint as a string', async () => {
    // The other direction of the same parse: dropping the Number() call
    // leaves `'1000'`, which isOverQuota refuses as a non-integer. toBe, not
    // toMatchObject, so a string cannot satisfy it by coercion.
    const c = new ProjectCache(pg, 60_000)
    const p = await c.byWriteKey('wk_cache')
    expect(p?.monthlyEventQuota).toBe(1000)
    expect(() => isOverQuota(0, 0, p?.monthlyEventQuota ?? null)).not.toThrow()
  })

  it('resolves a project by server key using the stored hash', async () => {
    const c = new ProjectCache(pg, 60_000)
    expect(await c.byServerKey('sk_cache')).toMatchObject({ slug: 'cache-test' })
    expect(await c.byServerKey('sk_wrong')).toBeNull()
  })

  it('serves the last known answer when the database becomes unavailable', async () => {
    // TTL 0 forces a refetch on every call, so the second lookup genuinely
    // hits the database and genuinely fails — no reaching into internals.
    const doomed = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
    const c = new ProjectCache(doomed, 0)
    expect(await c.byWriteKey('wk_cache')).toMatchObject({ slug: 'cache-test' })

    await doomed.end() // every subsequent query on this pool now throws
    expect(await c.byWriteKey('wk_cache')).toMatchObject({ slug: 'cache-test' })
  })

  it('caches misses so a bad key cannot become a query flood', async () => {
    const c = new ProjectCache(pg, 60_000)
    expect(await c.byWriteKey('wk_nope')).toBeNull()
    expect(await c.byWriteKey('wk_nope')).toBeNull()
    expect(c.stats.queries).toBe(1)
  })

  it('refetches after the TTL expires', async () => {
    const c = new ProjectCache(pg, 0)
    await c.byWriteKey('wk_cache')
    await c.byWriteKey('wk_cache')
    expect(c.stats.queries).toBe(2)
  })
})

/**
 * CRITICAL 1: the ingest port is public and its write key is public by design,
 * so an unauthenticated scanner can make this cache store an entry for every
 * random key it sends. Before the bound, `#entries` was only ever added to or
 * wholesale cleared — the TTL governed freshness, not lifetime — so the map
 * grew monotonically until the process was OOM-killed, taking every buffered
 * accepted event with it.
 */
describe('ProjectCache bounds (CRITICAL 1)', () => {
  const FLOOD = MAX_NEGATIVE_ENTRIES * 3

  it('never grows past the negative-entry cap, however many distinct unknown keys arrive', async () => {
    const c = new ProjectCache(pg, 60_000)
    for (let i = 0; i < FLOOD; i++) await c.byWriteKey(`wk_scanner_${i}`)

    // Catches the mutation of deleting the eviction loop in #store (or
    // reverting to the single unbounded #entries map): the map would then hold
    // all FLOOD keys instead of at most MAX_NEGATIVE_ENTRIES.
    expect(c.stats.negativeEntries).toBeLessThanOrEqual(MAX_NEGATIVE_ENTRIES)
    expect(c.stats.queries).toBe(FLOOD) // every distinct key really was a miss
  })

  it('still serves a valid key from cache after eviction pressure from invalid ones', async () => {
    const c = new ProjectCache(pg, 60_000)
    expect(await c.byWriteKey('wk_cache')).toMatchObject({ slug: 'cache-test' })
    const queriesAfterValidLookup = c.stats.queries

    for (let i = 0; i < FLOOD; i++) await c.byWriteKey(`wk_scanner_${i}`)

    expect(await c.byWriteKey('wk_cache')).toMatchObject({ slug: 'cache-test' })
    // Catches the mutation of using one shared LRU map for both kinds of
    // answer: the flood would evict the real project, and this second lookup
    // would cost another Postgres query rather than being a cache hit — which
    // is exactly how a scanner turns into a query flood against a `max: 10`
    // pool even *with* a cap in place.
    expect(c.stats.queries).toBe(queriesAfterValidLookup + FLOOD)
    expect(c.stats.positiveEntries).toBe(1)
  })

  it('expires negative entries on their own, shorter TTL', async () => {
    // 60s positive TTL, 20ms negative TTL: long enough that a positive entry
    // cannot possibly expire during the test, short enough to observe.
    const c = new ProjectCache(pg, 60_000, 20)
    await c.byWriteKey('wk_cache') // positive control
    await c.byWriteKey('wk_nope_ttl') // negative
    expect(c.stats.queries).toBe(2)

    await new Promise((r) => setTimeout(r, 40))

    await c.byWriteKey('wk_cache')
    // Control: the positive entry is untouched by the negative TTL. Catches a
    // mutation that applies the shorter TTL to everything, which would turn
    // every legitimate event into a Postgres round trip.
    expect(c.stats.queries).toBe(2)

    await c.byWriteKey('wk_nope_ttl')
    // Catches the mutation of reusing `ttlMs` for negative entries: the entry
    // would still be fresh at 40ms and this would stay at 2.
    expect(c.stats.queries).toBe(3)
  })
})
