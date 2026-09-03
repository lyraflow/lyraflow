import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChClient, createPgPool } from '../clients.js'
import { loadMigrations, migrate } from '../migrator.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

const SLUG = 'dashboards-023'
let projectId: number

const TILE = { kind: 'trend', report_id: 1, width: 'half' }

async function insert(name: string, tiles: unknown, isHome = false): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO dashboards (project_id, name, definition_version, tiles, is_home)
     VALUES ($1, $2, 1, $3::jsonb, $4) RETURNING id`,
    [projectId, name, JSON.stringify(tiles), isHome],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Dashboards 023', $1, 'wk_023', 'hash_023') RETURNING id`,
    [SLUG],
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.end()
  await ch.close()
})

describe('023_dashboards', () => {
  it('stores a layout of twelve tiles and reads it back in order', async () => {
    const tiles = Array.from({ length: 12 }, (_, i) => ({ ...TILE, report_id: i + 1 }))
    const id = await insert('Twelve', tiles)
    const r = await pg.query<{ tiles: unknown[] }>('SELECT tiles FROM dashboards WHERE id = $1', [
      id,
    ])
    expect(r.rows[0]?.tiles).toEqual(tiles)
  })

  it('refuses a thirteenth tile at the database, not only in validation', async () => {
    const tiles = Array.from({ length: 13 }, (_, i) => ({ ...TILE, report_id: i + 1 }))
    await expect(insert('Thirteen', tiles)).rejects.toThrow(/dashboards_tiles_at_most_12/)
  })

  it('refuses tiles that are not an array', async () => {
    await expect(insert('Object', { kind: 'trend' })).rejects.toThrow(/dashboards_tiles_is_array/)
  })

  it('refuses a duplicate name within a project', async () => {
    await insert('Same', [])
    await expect(insert('Same', [])).rejects.toThrow(/duplicate key/i)
  })

  it('allows exactly one home per project, at the index', async () => {
    await insert('Home A', [], true)
    await expect(insert('Home B', [], true)).rejects.toThrow(/dashboards_one_home_per_project/)
    // A second non-home row is fine: the index is partial.
    await insert('Not home', [], false)
  })

  it('cascades from the project', async () => {
    await insert('Doomed', [])
    await pg.query('DELETE FROM projects WHERE id = $1', [projectId])
    const r = await pg.query('SELECT count(*)::int AS n FROM dashboards WHERE project_id = $1', [
      projectId,
    ])
    expect(r.rows[0]?.n).toBe(0)
    // Re-create so afterAll's DELETE has something harmless to do.
    const again = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Dashboards 023', $1, 'wk_023', 'hash_023') RETURNING id`,
      [SLUG],
    )
    projectId = Number(again.rows[0]?.id)
  })
})
