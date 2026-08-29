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

const SLUG = 'trend-predicates-021'
let projectId: number

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  // Everything through 020, so `trend_reports` exists in its pre-021 shape
  // -- the exact state a real deployment is in the moment before this
  // migration runs.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')).filter(
      (m) => m.version < 21,
    ),
    appSchemaVersion: 999,
  })
  // Migrations are never rolled back, and the local test database is shared
  // across runs and branches, so a prior run of THIS SUITE can leave 021
  // already applied even though the migrate() call above was filtered to
  // exclude it -- the filter only controls which files THIS call considers,
  // it does not touch what is on disk already. Force the pre-021 shape
  // explicitly rather than assume the filter produced it. The ledger row
  // matters as much as the columns: migrate() decides what to (re)run by
  // checking `schema_migrations` for the version, not by inspecting live
  // columns, so leaving version 21 recorded there would make the full
  // migrate() below skip it -- which is exactly what dropping only the
  // columns did on a database where 021 had already run once. All four
  // statements are no-ops on a database that was never migrated past 020,
  // and undo 021 on one that was.
  await pg.query('DELETE FROM schema_migrations WHERE version >= 21')
  await pg.query('ALTER TABLE trend_reports DROP CONSTRAINT IF EXISTS trend_reports_where_is_array')
  await pg.query('ALTER TABLE trend_reports DROP COLUMN IF EXISTS event_where')
  await pg.query('ALTER TABLE trend_reports DROP COLUMN IF EXISTS definition_version')
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Trend predicates', $1, 'wk_021', 'hash_021') RETURNING id`,
    [SLUG],
  )
  projectId = Number(r.rows[0]?.id)
  await pg.query(
    `INSERT INTO trend_reports (project_id, name, event, interval, group_by)
     VALUES ($1, 'pre-existing', 'signup', '1d', NULL)`,
    [projectId],
  )
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.end()
  await ch.close()
})

describe('021_trend_predicates', () => {
  it('backfills a row that existed before the column did', async () => {
    // The risk this migration carries: a NOT NULL column added to a table
    // with rows in it. An unfilled row would be a report the store cannot
    // hydrate, found by an operator rather than by CI.
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
      appSchemaVersion: 999,
    })
    const r = await pg.query<{ event_where: unknown; definition_version: number }>(
      'SELECT event_where, definition_version FROM trend_reports WHERE project_id = $1',
      [projectId],
    )
    expect(r.rows[0]?.event_where).toEqual([])
    expect(r.rows[0]?.definition_version).toBe(1)
  })

  it('refuses a stored value that is not an array', async () => {
    // The column is the only thing standing between a hand-written UPDATE
    // and a store that reports every row stale.
    await expect(
      pg.query(
        `UPDATE trend_reports SET event_where = '{"property":"path"}'::jsonb
         WHERE project_id = $1`,
        [projectId],
      ),
    ).rejects.toThrow()
  })

  it('leaves definition_version with no default, so every insert states it', async () => {
    // Dropped deliberately: `retention_reports` has no default either, and a
    // defaultable version column is one an insert can forget to stamp.
    const r = await pg.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_name = 'trend_reports' AND column_name = 'definition_version'`,
    )
    expect(r.rows[0]?.column_default).toBeNull()
  })
})
