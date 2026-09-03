import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DashboardStore, DuplicateDashboardNameError, type Tile } from './store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

let projectA: number
let projectB: number
const store = new DashboardStore(pg)

const tile = (report_id: number, width: Tile['width'] = 'half'): Tile => ({
  kind: 'trend',
  report_id,
  width,
})

async function project(slug: string): Promise<number> {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $1, $2, $3) RETURNING id`,
    [slug, `wk_${slug}`, `hash_${slug}`],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  projectA = await project('dash-store-a')
  projectB = await project('dash-store-b')
})

beforeEach(async () => {
  await pg.query('DELETE FROM dashboards WHERE project_id = ANY($1)', [[projectA, projectB]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [['dash-store-a', 'dash-store-b']])
  await pg.end()
  await ch.close()
})

describe('DashboardStore', () => {
  it('round-trips a layout, tiles in order', async () => {
    const made = await store.create(projectA, {
      name: 'Overview',
      tiles: [tile(3), tile(1, 'full')],
    })
    const read = await store.get(projectA, made.id)
    expect(read).toMatchObject({
      name: 'Overview',
      tiles: [tile(3), tile(1, 'full')],
      is_home: false,
      definition_version: 1,
      stale: false,
    })
  })

  it('refuses a duplicate name in one project, and allows it across two', async () => {
    await store.create(projectA, { name: 'Same', tiles: [] })
    await expect(store.create(projectA, { name: 'Same', tiles: [] })).rejects.toBeInstanceOf(
      DuplicateDashboardNameError,
    )
    await expect(store.create(projectB, { name: 'Same', tiles: [] })).resolves.toMatchObject({
      name: 'Same',
    })
  })

  it('refuses a rename onto an existing name', async () => {
    await store.create(projectA, { name: 'One', tiles: [] })
    const two = await store.create(projectA, { name: 'Two', tiles: [] })
    await expect(store.update(projectA, two.id, { name: 'One' })).rejects.toBeInstanceOf(
      DuplicateDashboardNameError,
    )
  })

  it('scopes get, update and remove to the project', async () => {
    const made = await store.create(projectA, { name: 'Mine', tiles: [] })
    expect(await store.get(projectB, made.id)).toBeNull()
    expect(await store.update(projectB, made.id, { name: 'Theirs' })).toBeNull()
    expect(await store.remove(projectB, made.id)).toBe(false)
    expect((await store.get(projectA, made.id))?.name).toBe('Mine')
  })

  it('replaces the whole layout on a tiles patch and re-stamps the version', async () => {
    const made = await store.create(projectA, { name: 'L', tiles: [tile(1), tile(2)] })
    await pg.query('UPDATE dashboards SET definition_version = 0 WHERE id = $1', [made.id])
    const updated = await store.update(projectA, made.id, { tiles: [tile(2, 'full')] })
    expect(updated?.tiles).toEqual([tile(2, 'full')])
    expect(updated?.definition_version).toBe(1)
  })

  it('a rename alone leaves the version alone', async () => {
    const made = await store.create(projectA, { name: 'R', tiles: [tile(1)] })
    await pg.query('UPDATE dashboards SET definition_version = 0 WHERE id = $1', [made.id])
    const updated = await store.update(projectA, made.id, { name: 'R2' })
    expect(updated?.definition_version).toBe(0)
    expect(updated?.tiles).toEqual([tile(1)])
  })

  it('setting home moves it: the previous home is cleared in the same transaction', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectA, { name: 'B', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectA, b.id, { is_home: true })
    const list = await store.list(projectA)
    expect(list.filter((d) => d.is_home).map((d) => d.name)).toEqual(['B'])
  })

  it('two concurrent set-home patches end with exactly one home', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectA, { name: 'B', tiles: [] })
    await Promise.all([
      store.update(projectA, a.id, { is_home: true }),
      store.update(projectA, b.id, { is_home: true }),
    ])
    const list = await store.list(projectA)
    expect(list.filter((d) => d.is_home)).toHaveLength(1)
  })

  it('home is per project: two projects each keep their own', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectB, { name: 'B', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectB, b.id, { is_home: true })
    expect((await store.get(projectA, a.id))?.is_home).toBe(true)
    expect((await store.get(projectB, b.id))?.is_home).toBe(true)
  })

  it('is_home: false clears it, and deleting the home leaves none', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectA, a.id, { is_home: false })
    expect((await store.get(projectA, a.id))?.is_home).toBe(false)
    await store.update(projectA, a.id, { is_home: true })
    await store.remove(projectA, a.id)
    expect((await store.list(projectA)).some((d) => d.is_home)).toBe(false)
  })

  it('a row whose tiles no longer parse reads back stale, with no tiles, and does not fail the list', async () => {
    await pg.query(
      `INSERT INTO dashboards (project_id, name, definition_version, tiles)
       VALUES ($1, 'Broken', 1, '[{"kind":"pie","report_id":1,"width":"half"}]'::jsonb)`,
      [projectA],
    )
    await store.create(projectA, { name: 'Fine', tiles: [tile(1)] })
    const list = await store.list(projectA)
    expect(list.find((d) => d.name === 'Broken')).toMatchObject({ stale: true, tiles: [] })
    expect(list.find((d) => d.name === 'Fine')).toMatchObject({ stale: false })
  })

  it('definition_version is a column, queryable without parsing tiles', async () => {
    const made = await store.create(projectA, { name: 'V', tiles: [tile(1)] })
    const r = await pg.query<{ definition_version: number }>(
      'SELECT definition_version FROM dashboards WHERE id = $1',
      [made.id],
    )
    expect(r.rows[0]?.definition_version).toBe(1)
  })
})
