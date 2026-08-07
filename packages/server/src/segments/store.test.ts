import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuplicateNameError, SegmentStore, StoredTreeError } from './store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new SegmentStore(pg)
let projectId: number
let otherProjectId: number

const trial = {
  ast_version: 1 as const,
  filter: { kind: 'trait' as const, key: 'plan', operator: '=' as const, value: 'trial' },
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['segstore-a', 'segstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'segstore-a', 'wk_segstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'segstore-b', 'wk_segstore_b', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
  otherProjectId = Number(b.rows[0]?.id)
})

afterAll(async () => {
  for (const slug of ['segstore-a', 'segstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  await pg.end()
  await ch.close()
})

describe('SegmentStore', () => {
  it('round-trips a segment', async () => {
    const created = await store.create(projectId, 'Trial', trial)
    const read = await store.get(projectId, created.id)
    expect(read?.filter).toEqual(trial.filter)
    expect(read?.lastCount).toBeNull()
  })

  it('refuses a duplicate name in the same project', async () => {
    await store.create(projectId, 'Dupe', trial)
    await expect(store.create(projectId, 'Dupe', trial)).rejects.toBeInstanceOf(DuplicateNameError)
  })

  it('refuses to rename a segment onto another segment name', async () => {
    await store.create(projectId, 'Original', trial)
    const other = await store.create(projectId, 'Renamable', trial)
    await expect(store.update(projectId, other.id, { name: 'Original' })).rejects.toBeInstanceOf(
      DuplicateNameError,
    )
  })

  it('allows the same name in a different project', async () => {
    await store.create(projectId, 'Shared name', trial)
    await expect(store.create(otherProjectId, 'Shared name', trial)).resolves.toBeDefined()
  })

  it('does not return another project segment', async () => {
    const mine = await store.create(projectId, 'Mine', trial)
    expect(await store.get(otherProjectId, mine.id)).toBeNull()
  })

  it('records a run', async () => {
    const s = await store.create(projectId, 'Runnable', trial)
    await store.recordRun(projectId, s.id, 42, new Date('2026-08-07T00:00:00.000Z'))
    const read = await store.get(projectId, s.id)
    expect(read?.lastCount).toBe(42)
    expect(read?.lastEvaluatedAt).not.toBeNull()
  })

  it('clears the snapshot when the filter changes, but not when only the name does', async () => {
    // A stored count describes the tree it came from. Leaving it after an
    // edit makes a list screen display a confident number for a segment that
    // no longer exists.
    const s = await store.create(projectId, 'Editable', trial)
    await store.recordRun(projectId, s.id, 7, new Date())

    await store.update(projectId, s.id, { name: 'Renamed' })
    expect((await store.get(projectId, s.id))?.lastCount).toBe(7)

    await store.update(projectId, s.id, {
      query: {
        ast_version: 1,
        filter: { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      },
    })
    const after = await store.get(projectId, s.id)
    expect(after?.lastCount).toBeNull()
    expect(after?.lastEvaluatedAt).toBeNull()
  })

  it('rejects a stored tree whose ast_version is no longer understood', async () => {
    // The version alone is disqualifying, regardless of the tree's contents —
    // so this row carries a filter that WOULD parse under version 1.
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Ancient version', 99, $2::jsonb)`,
      [projectId, JSON.stringify(trial.filter)],
    )
    const r = await pg.query<{ id: string }>(
      "SELECT id FROM segments WHERE project_id = $1 AND name = 'Ancient version'",
      [projectId],
    )
    const id = Number(r.rows[0]?.id)
    await expect(store.get(projectId, id)).rejects.toBeInstanceOf(StoredTreeError)
  })

  it('rejects a malformed stored tree even under the current ast_version', async () => {
    // The half the combined test could not prove: a hydrate that checked only
    // the version would let this through, and would admit a malformed tree
    // for every row written by the current build.
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Malformed current', 1, '{"kind":"nonsense"}'::jsonb)`,
      [projectId],
    )
    const r = await pg.query<{ id: string }>(
      "SELECT id FROM segments WHERE project_id = $1 AND name = 'Malformed current'",
      [projectId],
    )
    const id = Number(r.rows[0]?.id)
    await expect(store.get(projectId, id)).rejects.toBeInstanceOf(StoredTreeError)
  })

  it('deletes', async () => {
    const s = await store.create(projectId, 'Temporary', trial)
    expect(await store.remove(projectId, s.id)).toBe(true)
    expect(await store.get(projectId, s.id)).toBeNull()
    expect(await store.remove(projectId, s.id)).toBe(false)
  })

  it('lists every segment in name order', async () => {
    await store.create(projectId, 'List: Zebra', trial)
    await store.create(projectId, 'List: Aardvark', trial)
    const names = (await store.list(projectId))
      .map((s) => s.name)
      .filter((n) => n.startsWith('List: '))
    expect(names).toEqual(['List: Aardvark', 'List: Zebra'])
  })

  it('does not list another project segment', async () => {
    await store.create(projectId, 'List: mine only', trial)
    const names = (await store.list(otherProjectId)).map((s) => s.name)
    expect(names).not.toContain('List: mine only')
  })

  // THE test for the finding this closes: get() correctly throws for a
  // single unparseable row (see the two tests above it), but list() must
  // not — one bad row aborting the ENTIRE list is exactly the situation
  // ast_version was stored to make diagnosable, and it takes every OTHER
  // segment in the project down with it. Without the fix, this throws
  // StoredTreeError instead of returning.
  it('marks a single unparseable row as stale rather than failing the whole list', async () => {
    const good = await store.create(projectId, 'List: good segment', trial)
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'List: bad segment', 99, $2::jsonb)`,
      [projectId, JSON.stringify(trial.filter)],
    )

    const listed = await store.list(projectId)

    const goodRow = listed.find((s) => s.id === good.id)
    expect(goodRow?.filter).toEqual(trial.filter)
    expect(goodRow && 'stale' in goodRow ? goodRow.stale : false).toBe(false)

    const badRow = listed.find((s) => s.name === 'List: bad segment')
    expect(badRow).toBeDefined()
    expect(badRow?.filter).toBeNull()
    expect(badRow && 'stale' in badRow && badRow.stale).toBe(true)
  })
})
