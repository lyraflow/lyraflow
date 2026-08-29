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
      where: [],
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
    await store.create(projectA, {
      name: 'Dupe',
      event: 'signup',
      interval: '1d',
      group_by: null,
      where: [],
    })
    await expect(
      store.create(projectA, {
        name: 'Dupe',
        event: 'login',
        interval: '1h',
        group_by: null,
        where: [],
      }),
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
      where: [],
    })
    await expect(
      store.create(projectB, {
        name: 'Shared',
        event: 'signup',
        interval: '1d',
        group_by: null,
        where: [],
      }),
    ).resolves.toMatchObject({ name: 'Shared' })
  })

  it('scopes reads to the project', async () => {
    const made = await store.create(projectA, {
      name: 'A only',
      event: 'e',
      interval: '1d',
      group_by: null,
      where: [],
    })
    expect(await store.get(projectB, made.id)).toBeNull()
  })

  it('renaming to a taken name is a duplicate, not a 500', async () => {
    await store.create(projectA, {
      name: 'One',
      event: 'e',
      interval: '1d',
      group_by: null,
      where: [],
    })
    const two = await store.create(projectA, {
      name: 'Two',
      event: 'e',
      interval: '1d',
      group_by: null,
      where: [],
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
        where: [],
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
        where: [],
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
        where: [],
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
        where: [],
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
        where: [],
      })
      await store.update(projectA, made.id, { name: 'Renamed, not re-grouped v2' })
      expect((await store.get(projectA, made.id))?.group_by).toBe('attribute:country')
      await store.update(projectA, made.id, { group_by: null })
      expect((await store.get(projectA, made.id))?.group_by).toBeNull()
    })
  })

  // Creates and deletes its OWN project rather than `projectA`, unlike an
  // earlier version of this test -- `projectA` is shared by every other
  // test in this file, so deleting it outright made this test's position
  // load-bearing: appended after it, the next describe block would run
  // every test against a project that no longer exists. A throwaway project
  // needs no `afterAll` cleanup (it is gone by the end of the test) and
  // this test can now sit anywhere in the file.
  it('a deleted project takes its trends with it', async () => {
    const doomed = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Doomed', 'trendstore-doomed', 'wk_trendstore_doomed', 'h') RETURNING id`,
    )
    const doomedProjectId = Number(doomed.rows[0]?.id)
    const made = await store.create(doomedProjectId, {
      name: 'Doomed',
      event: 'e',
      interval: '1d',
      group_by: null,
      where: [],
    })
    await pg.query('DELETE FROM projects WHERE id = $1', [doomedProjectId])
    const { rows } = await pg.query('SELECT 1 FROM trend_reports WHERE id = $1', [made.id])
    expect(rows).toHaveLength(0)
  })
})

describe('TrendStore where predicates', () => {
  const base = { event: 'signup', interval: '1d' as const, group_by: null }

  it('round-trips a predicate list', async () => {
    const made = await store.create(projectA, {
      ...base,
      name: 'filtered',
      where: [{ property: 'path', operator: '=', value: '/register' }],
    })
    expect(made.where).toEqual([{ property: 'path', operator: '=', value: '/register' }])
    expect(made.definition_version).toBe(1)
    expect(made.stale).toBe(false)
    const read = await store.get(projectA, made.id)
    expect(read?.where).toEqual(made.where)
    expect(read?.stale).toBe(false)
  })

  it('defaults to no predicates', async () => {
    const made = await store.create(projectA, { ...base, name: 'plain', where: [] })
    expect(made.where).toEqual([])
    expect(made.stale).toBe(false)
  })

  it('clears the filter on an explicit empty list', async () => {
    const made = await store.create(projectA, {
      ...base,
      name: 'to-clear',
      where: [{ property: 'path', operator: '=', value: '/x' }],
    })
    const patched = await store.update(projectA, made.id, { where: [] })
    expect(patched?.where).toEqual([])
  })

  it('leaves the filter alone when the key is absent', async () => {
    // The three-way distinction `group_by` already draws. A rename must not
    // silently widen the report.
    const made = await store.create(projectA, {
      ...base,
      name: 'to-rename',
      where: [{ property: 'path', operator: '=', value: '/keep' }],
    })
    const patched = await store.update(projectA, made.id, { name: 'renamed' })
    expect(patched?.name).toBe('renamed')
    expect(patched?.where).toEqual([{ property: 'path', operator: '=', value: '/keep' }])
  })

  it('reports a row it cannot parse as stale instead of throwing', async () => {
    // One row a past build wrote, that a later grammar can no longer parse,
    // must not take the whole LIST down with it. Without the healthy row
    // alongside it, this file's own `beforeEach` leaves the table with
    // exactly the one broken row, and a length assertion greater than one
    // row is unreachable -- so this test could only ever prove the flag
    // flipped, never that a broken row survives a LIST beside healthy ones.
    await store.create(projectA, { ...base, name: 'healthy', where: [] })
    const made = await store.create(projectA, { ...base, name: 'broken', where: [] })
    await pg.query(
      `UPDATE trend_reports SET event_where = '[{"property":"path","operator":"wat"}]'::jsonb
       WHERE id = $1`,
      [made.id],
    )
    const listed = await store.list(projectA)
    const broken = listed.find((t) => t.id === made.id)
    expect(broken?.stale).toBe(true)
    // The raw, unparsed JSON survives rather than being discarded -- a
    // failure branch that returned `[]` instead would pass every other
    // assertion in this suite.
    expect(broken?.where).toEqual([{ property: 'path', operator: 'wat' }])
    expect(listed).toHaveLength(2)
    expect(listed.find((t) => t.name === 'healthy')?.stale).toBe(false)
  })

  it('re-stamps the version when the predicates are written', async () => {
    // Whatever THIS build parsed and wrote is what the row now holds, so a
    // future migration finding "every row written under the old shape" is
    // not defeated by a PATCH that left an old stamp behind.
    const made = await store.create(projectA, { ...base, name: 'stamped', where: [] })
    await pg.query('UPDATE trend_reports SET definition_version = 0 WHERE id = $1', [made.id])
    const patched = await store.update(projectA, made.id, {
      where: [{ property: 'path', operator: '=', value: '/n' }],
    })
    expect(patched?.definition_version).toBe(1)
  })

  it('leaves the version alone on a patch that does not touch the predicates', async () => {
    const made = await store.create(projectA, { ...base, name: 'unstamped', where: [] })
    await pg.query('UPDATE trend_reports SET definition_version = 0 WHERE id = $1', [made.id])
    const patched = await store.update(projectA, made.id, { name: 'unstamped-2' })
    expect(patched?.definition_version).toBe(0)
  })
})
