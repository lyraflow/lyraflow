import { createPgPool } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectCache, hashServerKey } from './project-cache.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['cache-test'])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, monthly_event_quota)
     VALUES ('Cache Test', 'cache-test', 'wk_cache', $1, 1000)`,
    [hashServerKey('sk_cache')],
  )
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['cache-test'])
  await pg.end()
})

describe('ProjectCache', () => {
  it('resolves a project by write key', async () => {
    const c = new ProjectCache(pg, 60_000)
    const p = await c.byWriteKey('wk_cache')
    expect(p).toMatchObject({ slug: 'cache-test', monthlyEventQuota: 1000 })
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
