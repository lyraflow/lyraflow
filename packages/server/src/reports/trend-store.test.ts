import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DuplicateTrendNameError, TrendStore } from './trend-store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new TrendStore(pg)
let projectA: number
let projectB: number

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['trendstore-a', 'trendstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'trendstore-a', 'wk_trendstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'trendstore-b', 'wk_trendstore_b', 'h') RETURNING id`,
  )
  projectA = Number(a.rows[0]?.id)
  projectB = Number(b.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM trend_reports WHERE project_id = ANY($1)', [[projectA, projectB]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [['trendstore-a', 'trendstore-b']])
  await pg.end()
  await ch.close()
})

describe('TrendStore', () => {
  it('round-trips a definition', async () => {
    const made = await store.create(projectA, {
      name: 'Signups by day',
      event: 'signup',
      interval: '1d',
      group_by: 'attribute:country',
    })
    const read = await store.get(projectA, made.id)
    expect(read).toMatchObject({
      name: 'Signups by day',
      event: 'signup',
      interval: '1d',
      group_by: 'attribute:country',
    })
  })

  it('refuses a duplicate name in the same project', async () => {
    await store.create(projectA, { name: 'Dupe', event: 'signup', interval: '1d', group_by: null })
    await expect(
      store.create(projectA, { name: 'Dupe', event: 'login', interval: '1h', group_by: null }),
    ).rejects.toBeInstanceOf(DuplicateTrendNameError)
  })

  it('allows the same name in a DIFFERENT project', async () => {
    // The half that proves the constraint is scoped rather than global. A
    // UNIQUE on (name) alone would pass the test above and fail this one.
    await store.create(projectA, {
      name: 'Shared',
      event: 'signup',
      interval: '1d',
      group_by: null,
    })
    await expect(
      store.create(projectB, { name: 'Shared', event: 'signup', interval: '1d', group_by: null }),
    ).resolves.toMatchObject({ name: 'Shared' })
  })

  it('scopes reads to the project', async () => {
    const made = await store.create(projectA, {
      name: 'A only',
      event: 'e',
      interval: '1d',
      group_by: null,
    })
    expect(await store.get(projectB, made.id)).toBeNull()
  })

  it('renaming to a taken name is a duplicate, not a 500', async () => {
    await store.create(projectA, { name: 'One', event: 'e', interval: '1d', group_by: null })
    const two = await store.create(projectA, {
      name: 'Two',
      event: 'e',
      interval: '1d',
      group_by: null,
    })
    await expect(store.update(projectA, two.id, { name: 'One' })).rejects.toBeInstanceOf(
      DuplicateTrendNameError,
    )
  })

  /**
   * `group_by`'s tri-state PATCH -- mirrors `FunnelStore.update`'s five
   * `segment_id` tests (funnels/store.test.ts) exactly, adapted to a store
   * with no cached snapshot to also assert on. `TrendStore.update`'s
   * `group_by = CASE WHEN $6 THEN $7 ELSE group_by END` has three branches
   * (set, clear, leave alone) and nothing here exercises it without these:
   * a swapped `$6`/`$7` binding, or a mis-bound "was this key present"
   * flag, would leave every OTHER trend-store test green.
   */
  describe("group_by's tri-state update", () => {
    it('group_by set for the first time', async () => {
      const made = await store.create(projectA, {
        name: 'First breakdown',
        event: 'e',
        interval: '1d',
        group_by: null,
      })
      await store.update(projectA, made.id, { group_by: 'attribute:country' })
      expect((await store.get(projectA, made.id))?.group_by).toBe('attribute:country')
    })

    it('group_by cleared to null having previously been set', async () => {
      const made = await store.create(projectA, {
        name: 'Clearable',
        event: 'e',
        interval: '1d',
        group_by: 'attribute:country',
      })
      await store.update(projectA, made.id, { group_by: null })
      expect((await store.get(projectA, made.id))?.group_by).toBeNull()
    })

    it('group_by re-sent at its current value', async () => {
      const made = await store.create(projectA, {
        name: 'Unchanged breakdown',
        event: 'e',
        interval: '1d',
        group_by: 'attribute:country',
      })
      await store.update(projectA, made.id, { group_by: 'attribute:country' })
      expect((await store.get(projectA, made.id))?.group_by).toBe('attribute:country')
    })

    it('group_by explicitly re-cleared to null when it was already null', async () => {
      const made = await store.create(projectA, {
        name: 'Already clear',
        event: 'e',
        interval: '1d',
        group_by: null,
      })
      await store.update(projectA, made.id, { group_by: null })
      expect((await store.get(projectA, made.id))?.group_by).toBeNull()
    })

    it('tells a null group_by apart from an absent one', async () => {
      // undefined (the key omitted from the patch) leaves the breakdown
      // alone; explicit null clears it. Collapsing the two would make
      // "remove the breakdown" unexpressible through PATCH.
      const made = await store.create(projectA, {
        name: 'Renamed, not re-grouped',
        event: 'e',
        interval: '1d',
        group_by: 'attribute:country',
      })
      await store.update(projectA, made.id, { name: 'Renamed, not re-grouped v2' })
      expect((await store.get(projectA, made.id))?.group_by).toBe('attribute:country')
      await store.update(projectA, made.id, { group_by: null })
      expect((await store.get(projectA, made.id))?.group_by).toBeNull()
    })
  })

  // Last in the file: it deletes projectA outright, which every other test
  // in this suite depends on still existing.
  it('a deleted project takes its trends with it', async () => {
    const made = await store.create(projectA, {
      name: 'Doomed',
      event: 'e',
      interval: '1d',
      group_by: null,
    })
    await pg.query('DELETE FROM projects WHERE id = $1', [projectA])
    const { rows } = await pg.query('SELECT 1 FROM trend_reports WHERE id = $1', [made.id])
    expect(rows).toHaveLength(0)
  })
})
