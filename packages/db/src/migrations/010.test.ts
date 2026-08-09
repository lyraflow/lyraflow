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

const SLUG_EXISTING = 'retention-default-existing'
const SLUG_NEW = 'retention-default-new'

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_EXISTING, SLUG_NEW]])
  // Make sure every migration through 009 has run, so the table exists in
  // its pre-Plan-9 shape (retention_months DEFAULT 24, from 001_core.sql)
  // before this file drives 010 itself, below.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')).filter(
      (m) => m.version < 10,
    ),
    appSchemaVersion: 999,
  })
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_EXISTING, SLUG_NEW]])
  await pg.end()
  await ch.close()
})

describe('010_retention_default', () => {
  it("changes the column DEFAULT to 13 without touching an existing row's stored value", async () => {
    // Simulate a project created under the pre-Plan-9 default (24), before
    // this migration has ever run — the exact state a real deployment is in
    // the moment before `pnpm migrate` applies 010. If this migration were
    // ever changed to also run `UPDATE projects SET retention_months = 13`,
    // this project's row would silently drop from 24 to 13, halving its
    // retention on upgrade.
    await pg.query('ALTER TABLE projects ALTER COLUMN retention_months SET DEFAULT 24')
    const existing = await pg.query<{ id: string; retention_months: number }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Existing Project', $1, 'wk_ret_existing', 'h') RETURNING id, retention_months`,
      [SLUG_EXISTING],
    )
    expect(existing.rows[0]?.retention_months).toBe(24)

    // Apply 010_retention_default.sql for the first time.
    await pg.query('DELETE FROM schema_migrations WHERE version = 10')
    const { applied } = await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
      appSchemaVersion: 999,
    })
    expect(applied).toContain(10)

    // The pre-existing row's stored value is UNCHANGED.
    const after = await pg.query<{ retention_months: number }>(
      'SELECT retention_months FROM projects WHERE slug = $1',
      [SLUG_EXISTING],
    )
    expect(after.rows[0]?.retention_months).toBe(24)

    // A project created AFTER the migration gets the new default, 13.
    const fresh = await pg.query<{ retention_months: number }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Fresh Project', $1, 'wk_ret_new', 'h') RETURNING retention_months`,
      [SLUG_NEW],
    )
    expect(fresh.rows[0]?.retention_months).toBe(13)
  })

  it('is idempotent — reapplying finds nothing pending and leaves the default at 13', async () => {
    const { applied } = await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
      appSchemaVersion: 999,
    })
    expect(applied).toEqual([])

    const r = await pg.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'projects' AND column_name = 'retention_months'`,
    )
    expect(r.rows[0]?.column_default).toMatch(/13/)
  })
})
