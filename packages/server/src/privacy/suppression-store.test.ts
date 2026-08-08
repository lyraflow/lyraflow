import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SuppressionStore } from './suppression-store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new SuppressionStore(pg)
let projectId: number
let otherProjectId: number

async function cleanupProjects(): Promise<void> {
  for (const slug of ['suppstore-a', 'suppstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterAll: tests share these live
  // databases across files, and a run that died mid-suite would otherwise
  // leave rows from a previous attempt for the next run to collide with.
  await cleanupProjects()
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'suppstore-a', 'wk_suppstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'suppstore-b', 'wk_suppstore_b', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
  otherProjectId = Number(b.rows[0]?.id)
})

afterAll(async () => {
  await cleanupProjects()
  await pg.end()
  await ch.close()
})

describe('SuppressionStore', () => {
  it('returns null when no member of the group is suppressed', async () => {
    expect(await store.boundaryFor(projectId, ['nobody-here'])).toBeNull()
  })

  it('returns the boundary for a suppressed canonical', async () => {
    const at = new Date(Date.now() - 3_600_000)
    await store.upsert(pg, projectId, 'solo-1', at)
    expect((await store.boundaryFor(projectId, ['solo-1']))?.getTime()).toBe(at.getTime())
  })

  it('returns the LATEST boundary when several members of a group carry one', async () => {
    // A person merged from two ids, each deleted at a different time.
    //
    // This test used to assert the EARLIEST, on the reasoning that the
    // earliest instant is the "strictest" and therefore the fail-closed
    // direction. That is backwards, and it is worth being explicit about why,
    // because it reads plausibly: every consumer keeps events with
    // `timestamp > boundary`, so a SMALLER boundary hides LESS. The earliest
    // instant in a group is the most permissive value available.
    //
    // `max` is the only value that honours every request in the group at
    // once — it hides everything at or before the most recent deletion, which
    // necessarily includes everything the earlier ones asked to hide. Under
    // `min`, merging a person deleted long ago into a person deleted recently
    // rewound the second person's boundary and handed their erased events
    // back through the person read and the export
    // (post-request-mutation.test.ts pins that sequence end to end).
    const early = new Date(Date.now() - 6 * 3_600_000)
    const late = new Date(Date.now() - 1 * 3_600_000)
    await store.upsert(pg, projectId, 'grp-a', early)
    await store.upsert(pg, projectId, 'grp-b', late)
    expect((await store.boundaryFor(projectId, ['grp-a', 'grp-b']))?.getTime()).toBe(late.getTime())
  })

  it("does not see another project's suppression row", async () => {
    // Two projects, the SAME person id, only one deleted.
    await store.upsert(pg, otherProjectId, 'shared-id', new Date())
    expect(await store.boundaryFor(projectId, ['shared-id'])).toBeNull()
  })

  it('advances the boundary on a repeat deletion and never moves it back', async () => {
    const first = new Date(Date.now() - 5 * 3_600_000)
    const second = new Date(Date.now() - 2 * 3_600_000)
    await store.upsert(pg, projectId, 'repeat-1', first)
    expect((await store.upsert(pg, projectId, 'repeat-1', second)).getTime()).toBe(second.getTime())
    // And an out-of-order write does not rewind it.
    expect((await store.upsert(pg, projectId, 'repeat-1', first)).getTime()).toBe(second.getTime())
  })

  it('upsertMany writes one row per id, all at the same boundary instant', async () => {
    const at = new Date(Date.now() - 4 * 3_600_000)
    const result = await store.upsertMany(pg, projectId, ['many-a', 'many-b', 'many-c'], at)

    expect(new Set(result.keys())).toEqual(new Set(['many-a', 'many-b', 'many-c']))
    for (const value of result.values()) {
      expect(value.getTime()).toBe(at.getTime())
    }
    expect((await store.boundaryFor(projectId, ['many-a']))?.getTime()).toBe(at.getTime())
    expect((await store.boundaryFor(projectId, ['many-b']))?.getTime()).toBe(at.getTime())
    expect((await store.boundaryFor(projectId, ['many-c']))?.getTime()).toBe(at.getTime())
  })

  it('upsertMany applies GREATEST per id independently, not across the whole set', async () => {
    // 'indep-a' already carries a LATER boundary than this write (e.g. from
    // an earlier, unrelated deletion of a device since reused) — it must
    // keep its own later value. 'indep-b' has never been suppressed and
    // simply gets the new instant. One statement, two different outcomes.
    const earlier = new Date(Date.now() - 5 * 3_600_000)
    const later = new Date(Date.now() - 1 * 3_600_000)
    await store.upsert(pg, projectId, 'indep-a', later)

    const result = await store.upsertMany(pg, projectId, ['indep-a', 'indep-b'], earlier)
    expect(result.get('indep-a')?.getTime()).toBe(later.getTime())
    expect(result.get('indep-b')?.getTime()).toBe(earlier.getTime())
  })

  it('upsertMany dedupes its own input so a repeated id in one call does not conflict with itself', async () => {
    const at = new Date(Date.now() - 3_600_000)
    const result = await store.upsertMany(pg, projectId, ['dup-1', 'dup-1', 'dup-1'], at)
    expect(result.size).toBe(1)
    expect(result.get('dup-1')?.getTime()).toBe(at.getTime())
  })

  it('upsertMany short-circuits an empty set instead of querying', async () => {
    const poisonedPool = {
      query: () => {
        throw new Error('upsertMany queried instead of short-circuiting on an empty set')
      },
    } as unknown as Pool
    const storeWithPoisonedPool = new SuppressionStore(poisonedPool)
    expect(await storeWithPoisonedPool.upsertMany(poisonedPool, projectId, [], new Date())).toEqual(
      new Map(),
    )
  })

  it('short-circuits an empty group instead of querying', async () => {
    // Postgres itself returns null for `person_id = ANY('{}')`, so a test
    // that only checks the return value cannot tell a real short-circuit
    // apart from its absence — this store is pointed at a pool that THROWS
    // on any `query()` call, so the assertion can only pass if `boundaryFor`
    // returns before ever reaching the database.
    const poisonedPool = {
      query: () => {
        throw new Error('boundaryFor queried instead of short-circuiting on an empty group')
      },
    } as unknown as Pool
    const storeWithPoisonedPool = new SuppressionStore(poisonedPool)
    expect(await storeWithPoisonedPool.boundaryFor(projectId, [])).toBeNull()
  })
})
