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

let projectId: number

beforeAll(async () => {
  await pg.query('DROP TABLE IF EXISTS segments')
  await pg.query('DROP TABLE IF EXISTS schema_migrations')
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['segments-table-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Table', 'segments-table-test', 'wk_segtable', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['segments-table-test'])
  await pg.end()
  await ch.close()
})

describe('segments table', () => {
  it('stores a filter tree as jsonb and reads it back unchanged', async () => {
    const filter = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Trial users', 1, $2)`,
      [projectId, JSON.stringify(filter)],
    )
    const r = await pg.query<{ filter: unknown; last_count: string | null }>(
      'SELECT filter, last_count FROM segments WHERE project_id = $1',
      [projectId],
    )
    expect(r.rows[0]?.filter).toEqual(filter)
    expect(r.rows[0]?.last_count).toBeNull()
  })

  it('rejects two segments with the same name in one project', async () => {
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Duplicate', 1, '{}'::jsonb)`,
      [projectId],
    )
    await expect(
      pg.query(
        `INSERT INTO segments (project_id, name, ast_version, filter)
         VALUES ($1, 'Duplicate', 1, '{}'::jsonb)`,
        [projectId],
      ),
    ).rejects.toThrow(/unique|duplicate/i)
  })

  it('allows the same name in a different project', async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Neighbour', 'segments-neighbour', 'wk_neighbour', 'h') RETURNING id`,
    )
    const neighbour = Number(other.rows[0]?.id)
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Shared name', 1, '{}'::jsonb)`,
      [projectId],
    )
    await expect(
      pg.query(
        `INSERT INTO segments (project_id, name, ast_version, filter)
         VALUES ($1, 'Shared name', 1, '{}'::jsonb)`,
        [neighbour],
      ),
    ).resolves.toBeDefined()
    await pg.query('DELETE FROM projects WHERE id = $1', [neighbour])
  })

  it('deletes a project segments when the project goes', async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Doomed', 'segments-doomed', 'wk_doomed', 'h') RETURNING id`,
    )
    const doomed = Number(other.rows[0]?.id)
    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'Gone', 1, '{}'::jsonb)`,
      [doomed],
    )
    await pg.query('DELETE FROM projects WHERE id = $1', [doomed])
    const r = await pg.query<{ c: string }>(
      'SELECT count(*) AS c FROM segments WHERE project_id = $1',
      [doomed],
    )
    expect(Number(r.rows[0]?.c)).toBe(0)
  })

  it('reshapes a segments table left behind by an earlier migration', async () => {
    await pg.query('DROP TABLE IF EXISTS segments')
    await pg.query(`
      CREATE TABLE segments (
        id bigserial PRIMARY KEY,
        project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        filter_tree jsonb NOT NULL,
        ast_version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, name)
      )`)
    await pg.query('DROP TABLE IF EXISTS schema_migrations')
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
      appSchemaVersion: 999,
    })
    // Recreate the test project since migrations were replayed
    await pg.query('DELETE FROM projects WHERE slug = $1', ['segments-table-test'])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Segments Table', 'segments-table-test', 'wk_segtable', 'h') RETURNING id`,
    )
    projectId = Number(r.rows[0]?.id)

    const cols = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'segments'`,
    )
    const names = cols.rows.map((c) => c.column_name)
    expect(names).toContain('filter')
    expect(names).toContain('last_count')
    expect(names).toContain('last_evaluated_at')
    expect(names).not.toContain('filter_tree')
  })
})
