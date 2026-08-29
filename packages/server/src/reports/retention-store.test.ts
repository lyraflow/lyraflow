import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SegmentStore } from '../segments/store.js'
import {
  DuplicateRetentionNameError,
  type RetentionReportInput,
  RetentionReportStore,
} from './retention-store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new RetentionReportStore(pg)
const segments = new SegmentStore(pg)
let projectA: number
let projectB: number

/**
 * A trivial but REAL segment, created through `SegmentStore.create` rather
 * than a hand-written INSERT. The point of the segment-deletion test below
 * is that a genuine segment's deletion leaves `segment_id` on a retention
 * report intact -- a row that skipped the store's own validation would be
 * weaker evidence of that than one that went through it, and the random
 * suffix keeps repeated calls from colliding on `segments`' own unique name.
 */
async function makeSegment(projectId: number) {
  return segments.create(projectId, `Trial ${Math.random()}`, {
    ast_version: 1,
    filter: { kind: 'trait', key: 'plan', operator: '=', value: 'trial' },
  })
}

const base: RetentionReportInput = {
  name: 'Base',
  start_event: 'signup',
  return_event: 'login',
  start_where: [],
  return_where: [],
  granularity: 'week',
  periods: 8,
  segment_id: null,
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['retentionstore-a', 'retentionstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'retentionstore-a', 'wk_retentionstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'retentionstore-b', 'wk_retentionstore_b', 'h') RETURNING id`,
  )
  projectA = Number(a.rows[0]?.id)
  projectB = Number(b.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM retention_reports WHERE project_id = ANY($1)', [[projectA, projectB]])
  await pg.query('DELETE FROM segments WHERE project_id = ANY($1)', [[projectA, projectB]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['retentionstore-a', 'retentionstore-b'],
  ])
  await pg.end()
  await ch.close()
})

describe('RetentionReportStore', () => {
  it('round-trips a definition', async () => {
    const made = await store.create(projectA, {
      ...base,
      name: 'Signup to login',
      start_where: [{ property: 'plan', operator: '=', value: 'pro' }],
    })
    const read = await store.get(projectA, made.id)
    expect(read).toMatchObject({
      name: 'Signup to login',
      start_event: 'signup',
      return_event: 'login',
      start_where: [{ property: 'plan', operator: '=', value: 'pro' }],
      return_where: [],
      granularity: 'week',
      periods: 8,
      segment_id: null,
      stale: false,
    })
  })

  it('refuses a duplicate name in the same project', async () => {
    await store.create(projectA, { ...base, name: 'Dupe' })
    await expect(store.create(projectA, { ...base, name: 'Dupe' })).rejects.toBeInstanceOf(
      DuplicateRetentionNameError,
    )
  })

  it('allows the same name in a DIFFERENT project', async () => {
    // The half that proves the constraint is scoped rather than global. A
    // UNIQUE on (name) alone would pass the test above and fail this one.
    await store.create(projectA, { ...base, name: 'Shared' })
    await expect(store.create(projectB, { ...base, name: 'Shared' })).resolves.toMatchObject({
      name: 'Shared',
    })
  })

  it('scopes reads to the project', async () => {
    const made = await store.create(projectA, { ...base, name: 'A only' })
    expect(await store.get(projectB, made.id)).toBeNull()
  })

  it('renaming to a taken name is a duplicate, not a 500', async () => {
    await store.create(projectA, { ...base, name: 'One' })
    const two = await store.create(projectA, { ...base, name: 'Two' })
    await expect(store.update(projectA, two.id, { name: 'One' })).rejects.toBeInstanceOf(
      DuplicateRetentionNameError,
    )
  })

  // I3 from the whole-branch review: a PATCH that rewrites the predicates
  // must re-stamp `definition_version`, the same way `FunnelStore.update`
  // re-stamps its own on a `steps` write (`funnels/store.ts`'s own
  // docstring). Both rows below are inserted directly at version 0 --
  // `create()` always stamps the current version, so there is no way to
  // observe a version CHANGE by going through it alone.
  describe("definition_version's re-stamp on update", () => {
    it('a patch that writes predicates advances the stamp', async () => {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO retention_reports
           (project_id,name,definition_version,start_event,return_event,start_where,
            return_where,granularity,periods)
         VALUES ($1,'Old shape',0,'a','b','[]'::jsonb,'[]'::jsonb,'week',8)
         RETURNING id`,
        [projectA],
      )
      const id = Number(inserted.rows[0]?.id)
      const updated = await store.update(projectA, id, {
        start_where: [{ property: 'plan', operator: '=', value: 'pro' }],
      })
      expect(updated?.definition_version).toBe(1)
    })

    it('a patch that does not touch predicates leaves the stamp alone', async () => {
      const inserted = await pg.query<{ id: string }>(
        `INSERT INTO retention_reports
           (project_id,name,definition_version,start_event,return_event,start_where,
            return_where,granularity,periods)
         VALUES ($1,'Old shape, renamed',0,'a','b','[]'::jsonb,'[]'::jsonb,'week',8)
         RETURNING id`,
        [projectA],
      )
      const id = Number(inserted.rows[0]?.id)
      // Touches granularity and the name -- neither is the predicate tree.
      const updated = await store.update(projectA, id, {
        name: 'Renamed, not re-parsed',
        granularity: 'day',
      })
      expect(updated?.definition_version).toBe(0)
    })
  })

  it('keeps segment_id when the segment it names is deleted', async () => {
    // THE test for decision 3. ON DELETE CASCADE would remove the report;
    // ON DELETE SET NULL would erase the evidence that a restriction ever
    // existed, which is the information the operator needs in order to be
    // told it vanished. Mutate the column to either and this must fail.
    const seg = await makeSegment(projectA)
    const made = await store.create(projectA, { ...base, name: 'Restricted', segment_id: seg.id })
    await pg.query('DELETE FROM segments WHERE id = $1', [seg.id])
    const read = await store.get(projectA, made.id)
    expect(read?.segment_id).toBe(seg.id)
  })

  it('marks a row stale when its stored where predicates no longer parse', async () => {
    // Written directly, bypassing create()'s validation -- the row is what a
    // future grammar change leaves behind.
    await pg.query(
      `INSERT INTO retention_reports
         (project_id,name,definition_version,start_event,return_event,start_where,
          return_where,granularity,periods)
       VALUES ($1,'Broken',1,'a','b','[{"nonsense":true}]'::jsonb,'[]'::jsonb,'week',8)`,
      [projectA],
    )
    const listed = await store.list(projectA)
    expect(listed.find((r) => r.name === 'Broken')?.stale).toBe(true)
  })

  it('does not fail the whole list because one row is stale', async () => {
    // segments/routes.ts:51 records why: one unparseable row must not 400
    // the request that would have shown the other nine.
    await store.create(projectA, { ...base, name: 'Fine' })
    await pg.query(
      `INSERT INTO retention_reports
         (project_id,name,definition_version,start_event,return_event,start_where,
          return_where,granularity,periods)
       VALUES ($1,'Broken',1,'a','b','[{"nonsense":true}]'::jsonb,'[]'::jsonb,'week',8)`,
      [projectA],
    )
    const listed = await store.list(projectA)
    expect(listed.map((r) => r.name)).toEqual(expect.arrayContaining(['Fine', 'Broken']))
    expect(listed.find((r) => r.name === 'Fine')?.stale).toBe(false)
  })

  it('a deleted project takes its retention reports with it', async () => {
    // Last in the file: it deletes projectA outright, which every other
    // test in this suite depends on still existing.
    const made = await store.create(projectA, { ...base, name: 'Doomed' })
    await pg.query('DELETE FROM projects WHERE id = $1', [projectA])
    const { rows } = await pg.query('SELECT 1 FROM retention_reports WHERE id = $1', [made.id])
    expect(rows).toHaveLength(0)
  })
})
