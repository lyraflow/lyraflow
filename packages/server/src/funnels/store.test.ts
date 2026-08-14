import { join } from 'node:path'
import type { FunnelDefinition } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DuplicateFunnelNameError, FunnelStore, StoredDefinitionError } from './store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new FunnelStore(pg)
let projectId: number
let otherProjectId: number

const signup: FunnelDefinition = {
  steps: [
    { event: '$page', where: [{ property: 'path', operator: '=', value: '/' }] },
    { event: 'signed_up' },
  ],
  window_seconds: 604800,
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['funstore-a', 'funstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'funstore-a', 'wk_funstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'funstore-b', 'wk_funstore_b', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
  otherProjectId = Number(b.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM funnels WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [['funstore-a', 'funstore-b']])
  await pg.end()
  await ch.close()
})

describe('FunnelStore', () => {
  it('creates and reads back a definition', async () => {
    const created = await store.create(projectId, 'signup', signup)
    const found = await store.get(projectId, created.id)
    expect(found?.steps).toHaveLength(2)
    expect(found?.steps[0]?.where?.[0]?.value).toBe('/')
    expect(found?.windowSeconds).toBe(604800)
    expect(found?.definitionVersion).toBe(1)
  })

  it('finds a funnel by name, which is how the CLI addresses one', async () => {
    await store.create(projectId, 'signup', signup)
    expect((await store.getByName(projectId, 'signup'))?.name).toBe('signup')
    expect(await store.getByName(projectId, 'nope')).toBeNull()
  })

  it('rejects a duplicate name within a project', async () => {
    await store.create(projectId, 'signup', signup)
    await expect(store.create(projectId, 'signup', signup)).rejects.toBeInstanceOf(
      DuplicateFunnelNameError,
    )
  })

  it('allows the same name in a different project', async () => {
    await store.create(projectId, 'signup', signup)
    await expect(store.create(otherProjectId, 'signup', signup)).resolves.toBeDefined()
  })

  it('does not return another project’s funnel', async () => {
    const f = await store.create(projectId, 'signup', signup)
    expect(await store.get(otherProjectId, f.id)).toBeNull()
    expect(await store.remove(otherProjectId, f.id)).toBe(false)
  })

  it('clears the snapshot when the steps change', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, { entered: 100, converted: 10, at: new Date() })
    await store.update(projectId, f.id, { steps: [{ event: 'x' }, { event: 'y' }] })
    const after = await store.get(projectId, f.id)
    expect(after?.lastEntered).toBeNull()
    expect(after?.lastConverted).toBeNull()
    expect(after?.lastEvaluatedAt).toBeNull()
  })

  it('clears the snapshot when the window changes', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, { entered: 100, converted: 10, at: new Date() })
    await store.update(projectId, f.id, { windowSeconds: 60 })
    expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
  })

  it('clears the snapshot when the segment restriction changes', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, { entered: 100, converted: 10, at: new Date() })
    await store.update(projectId, f.id, { segmentId: 42 })
    const after = await store.get(projectId, f.id)
    expect(after?.segmentId).toBe(42)
    expect(after?.lastEntered).toBeNull()
  })

  it('KEEPS the snapshot on a rename', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, { entered: 100, converted: 10, at: new Date() })
    await store.update(projectId, f.id, { name: 'signup-v2' })
    const after = await store.get(projectId, f.id)
    expect(after?.name).toBe('signup-v2')
    expect(after?.lastEntered).toBe(100)
    expect(after?.lastConverted).toBe(10)
    expect(after?.lastEvaluatedAt).not.toBeNull()
  })

  it('tells a null segment_id apart from an absent one', async () => {
    // undefined leaves the restriction alone; null removes it. Collapsing the
    // two would make "remove the segment" unexpressible through PATCH.
    const f = await store.create(projectId, 'signup', { ...signup, segment_id: 7 })
    await store.update(projectId, f.id, { name: 'renamed' })
    expect((await store.get(projectId, f.id))?.segmentId).toBe(7)
    await store.update(projectId, f.id, { segmentId: null })
    expect((await store.get(projectId, f.id))?.segmentId).toBeNull()
  })

  it('surfaces an unparseable stored definition as stale in list(), not a throw', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await pg.query(`UPDATE funnels SET steps = '[{"nope": true}]'::jsonb WHERE id = $1`, [f.id])
    const listed = await store.list(projectId)
    expect(listed[0]).toMatchObject({ stale: true, steps: null, name: 'signup' })
  })

  it('does not let one bad row take down the rest of the list', async () => {
    const bad = await store.create(projectId, 'aaa-bad', signup)
    await store.create(projectId, 'zzz-good', signup)
    // A valid jsonb array — the CHECK constraint forbids anything else — whose
    // ELEMENTS no longer parse. That is the shape an older build would leave.
    await pg.query(
      `UPDATE funnels SET steps = '[{"evt": "a"}, {"evt": "b"}]'::jsonb WHERE id = $1`,
      [bad.id],
    )
    const listed = await store.list(projectId)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ name: 'aaa-bad', stale: true })
    expect(listed[1]).toMatchObject({ name: 'zzz-good' })
    expect(listed[1]).not.toHaveProperty('stale')
  })

  it('throws StoredDefinitionError from get() for the same row', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await pg.query(`UPDATE funnels SET steps = '[]'::jsonb WHERE id = $1`, [f.id])
    await expect(store.get(projectId, f.id)).rejects.toBeInstanceOf(StoredDefinitionError)
  })

  it('records a run snapshot', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, { entered: 51, converted: 7, at: new Date() })
    const after = await store.get(projectId, f.id)
    expect(after?.lastEntered).toBe(51)
    expect(after?.lastConverted).toBe(7)
    expect(after?.lastEvaluatedAt).not.toBeNull()
  })
})
