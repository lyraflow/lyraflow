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
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  // Migrations are never rolled back, and the local test database is shared
  // across runs and branches, so 023 is already applied here from an
  // earlier run -- and migrate() decides what to run by reading
  // `schema_migrations`, not by inspecting live tables. Left alone, this
  // suite would assert against whatever shape the FIRST run of it created
  // and never exercise the file on disk again, which is exactly how an
  // edit to the CHECK expressions below could go untested. Force the
  // pre-023 state -- the ledger row as well as the table -- so migrate()
  // re-runs the current text of `023_dashboards.sql`. Same pattern, same
  // reason as `022.test.ts`.
  await pg.query('DELETE FROM schema_migrations WHERE version = 23')
  await pg.query('DROP TABLE IF EXISTS dashboards')
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
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

  it('names the array CHECK for a scalar, never an array-length error', async () => {
    // Both CHECKs are evaluated for this row, and Postgres does not promise
    // the order of an expression's operands -- so the cap CHECK must not
    // call `jsonb_array_length` on a non-array at all. It raises there
    // ("cannot get array length of a scalar"), and that error is neither a
    // constraint violation the store can classify nor a message that names
    // what is actually wrong with the row.
    await expect(insert('Scalar', 5)).rejects.toThrow(/dashboards_tiles_is_array/)
    await expect(insert('String', 'twelve')).rejects.toThrow(/dashboards_tiles_is_array/)
  })

  it('guards the length CHECK structurally, not by an OR that happens to short-circuit', async () => {
    // The test above passes today under an `OR` too, because this server's
    // planner evaluated the type test first -- which is luck, not a
    // promise, and it is the whole reason this assertion reads the
    // constraint itself rather than trusting the behaviour.
    const r = await pg.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'dashboards'::regclass
          AND conname = 'dashboards_tiles_at_most_12'`,
    )
    const def = r.rows[0]?.def ?? ''
    expect(def).toMatch(/CASE\s+WHEN/i)
    expect(def).not.toMatch(/\bOR\b/i)
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
