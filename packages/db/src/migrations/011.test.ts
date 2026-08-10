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

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations')
const SLUG = 'quota-migration-existing'
const SLUG_NEW = 'quota-migration-new'

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_NEW]])
  // Make sure every migration through 010 has run, so the table exists in
  // its pre-Plan-10 shape before this file drives 011 itself, below.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(MIGRATIONS_DIR).filter((m) => m.version < 11),
    appSchemaVersion: 999,
  })
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_NEW]])
  await pg.end()
  await ch.close()
})

describe('011_quota', () => {
  it('makes every existing project unlimited, and new ones too', async () => {
    // Simulate a project created under the pre-Plan-10 default (50000000,
    // NOT NULL) -- the exact state a real deployment is in the moment
    // before `pnpm migrate` applies 011. The value is given explicitly
    // (rather than relying on the column DEFAULT) so this fixture is valid
    // whether or not 011 has already run once against this shared database,
    // which matters for repeated standalone runs of this file.
    await pg.query(
      `INSERT INTO projects (name, slug, write_key, server_key_hash, monthly_event_quota)
       VALUES ('Existing Quota Project', $1, 'wk_quota_existing', 'h', 50000000)`,
      [SLUG],
    )

    // The safe direction: this removes a limit nobody chose. A project with
    // an explicit value set AFTER the migration must keep it -- the
    // migration clears history, it does not pin the future.
    const before = await pg.query('SELECT monthly_event_quota FROM projects WHERE slug = $1', [
      SLUG,
    ])
    expect(before.rows[0].monthly_event_quota).toBe('50000000')

    // Force 011 to run again even if an earlier standalone run of this file
    // already applied it -- the same repeatability trick 010.test.ts uses.
    // The migration's own statements are idempotent (DROP NOT NULL / DROP
    // DEFAULT on an already-nullable/default-less column are no-ops, and
    // re-running `UPDATE ... SET NULL` is harmless), so this is safe.
    await pg.query('DELETE FROM schema_migrations WHERE version = 11')
    const { applied } = await migrate({
      pg,
      ch,
      migrations: loadMigrations(MIGRATIONS_DIR),
      appSchemaVersion: 999,
    })
    expect(applied).toContain(11)

    const after = await pg.query('SELECT monthly_event_quota FROM projects WHERE slug = $1', [SLUG])
    expect(after.rows[0].monthly_event_quota).toBeNull()

    // A project created AFTER the migration, the way `createProject` does it
    // -- the INSERT never names the column -- is unlimited too, because
    // DROP DEFAULT means there is no value left to fall back to.
    const fresh = await pg.query<{ monthly_event_quota: string | null }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Fresh Quota Project', $1, 'wk_quota_new', 'h') RETURNING monthly_event_quota`,
      [SLUG_NEW],
    )
    expect(fresh.rows[0]?.monthly_event_quota).toBeNull()
  })

  it('accepts an explicit quota, and still rejects a non-positive one', async () => {
    await pg.query('UPDATE projects SET monthly_event_quota = 1000 WHERE slug = $1', [SLUG])
    const set = await pg.query('SELECT monthly_event_quota FROM projects WHERE slug = $1', [SLUG])
    expect(set.rows[0].monthly_event_quota).toBe('1000')
    await expect(
      pg.query('UPDATE projects SET monthly_event_quota = 0 WHERE slug = $1', [SLUG]),
    ).rejects.toThrow()
  })

  it('gives ingest_counters an events_over_quota column that starts at 0', async () => {
    const projectId = (
      await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
    ).rows[0]?.id
    await pg.query('DELETE FROM ingest_counters WHERE project_id = $1', [projectId])
    const inserted = await pg.query<{ events_over_quota: string }>(
      `INSERT INTO ingest_counters (project_id, month) VALUES ($1, '2026-08-01')
       RETURNING events_over_quota`,
      [projectId],
    )
    expect(inserted.rows[0]?.events_over_quota).toBe('0')
  })

  it('is idempotent -- reapplying finds nothing pending', async () => {
    const { applied } = await migrate({
      pg,
      ch,
      migrations: loadMigrations(MIGRATIONS_DIR),
      appSchemaVersion: 999,
    })
    expect(applied).toEqual([])
  })
})
