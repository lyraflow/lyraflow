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

const SLUG = 'dashboard-shares-024'
let projectId: number

async function insert(
  name: string,
  token: string | null,
  sharedAt: string | null,
): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO dashboards (project_id, name, definition_version, tiles, share_token, shared_at)
     VALUES ($1, $2, 1, '[]'::jsonb, $3, $4) RETURNING id`,
    [projectId, name, token, sharedAt],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  // Same reason 023.test.ts gives: the shared test database already has 024
  // applied from an earlier run, and migrate() reads the ledger, not the
  // table. Force the pre-024 state so the file on disk is what runs.
  await pg.query('DELETE FROM schema_migrations WHERE version = 24')
  await pg.query('ALTER TABLE dashboards DROP CONSTRAINT IF EXISTS dashboards_share_pair')
  await pg.query('DROP INDEX IF EXISTS dashboards_share_token_key')
  await pg.query(
    'ALTER TABLE dashboards DROP COLUMN IF EXISTS share_token, DROP COLUMN IF EXISTS shared_at',
  )
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Dashboard shares 024', $1, 'wk_024', 'hash_024') RETURNING id`,
    [SLUG],
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.end()
  await ch.close()
})

describe('024_dashboard_shares', () => {
  it('adds two nullable columns that default to null', async () => {
    const id = await insert('plain', null, null)
    const r = await pg.query('SELECT share_token, shared_at FROM dashboards WHERE id = $1', [id])
    expect(r.rows[0]).toEqual({ share_token: null, shared_at: null })
  })

  it('refuses a token without a date, and a date without a token', async () => {
    await expect(insert('half-a', 'tok_a', null)).rejects.toMatchObject({
      constraint: 'dashboards_share_pair',
    })
    await expect(insert('half-b', null, '2026-09-05T00:00:00Z')).rejects.toMatchObject({
      constraint: 'dashboards_share_pair',
    })
  })

  it('refuses the same token twice, across projects', async () => {
    await insert('one', 'tok_dup', '2026-09-05T00:00:00Z')
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Other 024', 'dashboard-shares-024-other', 'wk_024o', 'hash_024o') RETURNING id`,
    )
    try {
      await expect(
        pg.query(
          `INSERT INTO dashboards (project_id, name, definition_version, tiles, share_token, shared_at)
           VALUES ($1, 'two', 1, '[]'::jsonb, 'tok_dup', now())`,
          [Number(other.rows[0]?.id)],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: 'dashboards_share_token_key' })
    } finally {
      await pg.query('DELETE FROM projects WHERE slug = $1', ['dashboard-shares-024-other'])
    }
  })

  it('allows many unshared rows (NULL is not a duplicate)', async () => {
    await insert('n1', null, null)
    await insert('n2', null, null)
  })
})
