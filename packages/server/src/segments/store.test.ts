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

  it('rejects a stored tree that no longer parses, naming the version', async () => {
    // The row may predate an AST change or have been written by an older
    // build. A stored tree is untrusted input on the way out.
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Ancient', 99, '{"kind":"nonsense"}'::jsonb)`,
      [projectId],
    )
    const r = await pg.query<{ id: string }>(
      "SELECT id FROM segments WHERE project_id = $1 AND name = 'Ancient'",
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
})
