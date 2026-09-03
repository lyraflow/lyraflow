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

const SLUG = 'wk-rotation-022'
const SLUG_2 = 'wk-rotation-022-b'
let projectId: number

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug IN ($1, $2)', [SLUG, SLUG_2])
  // Everything through 021, so `projects` exists in its pre-022 shape --
  // the exact state a real deployment is in the moment before this
  // migration runs.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')).filter(
      (m) => m.version < 22,
    ),
    appSchemaVersion: 999,
  })
  // Migrations are never rolled back, and the local test database is shared
  // across runs and branches, so a prior run of THIS SUITE can leave 022
  // already applied even though the migrate() call above was filtered to
  // exclude it -- the filter only controls which files THIS call considers,
  // it does not touch what is on disk already. Force the pre-022 shape
  // explicitly rather than assume the filter produced it. The ledger row
  // matters as much as the columns: migrate() decides what to (re)run by
  // checking `schema_migrations` for the version, not by inspecting live
  // columns, so leaving version 22 recorded there would make the full
  // migrate() below skip it.
  await pg.query('DELETE FROM schema_migrations WHERE version = 22')
  await pg.query('ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_previous_write_key_pair')
  await pg.query('DROP INDEX IF EXISTS projects_previous_write_key_key')
  await pg.query('ALTER TABLE projects DROP COLUMN IF EXISTS previous_write_key')
  await pg.query('ALTER TABLE projects DROP COLUMN IF EXISTS previous_write_key_expires_at')
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('WK rotation', $1, 'wk_022', 'hash_022') RETURNING id`,
    [SLUG],
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug IN ($1, $2)', [SLUG, SLUG_2])
  await pg.end()
  await ch.close()
})

describe('022_write_key_rotation', () => {
  it('adds both columns as null on a row that predates them', async () => {
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
      appSchemaVersion: 999,
    })
    const r = await pg.query<{
      previous_write_key: string | null
      previous_write_key_expires_at: Date | null
    }>('SELECT previous_write_key, previous_write_key_expires_at FROM projects WHERE id = $1', [
      projectId,
    ])
    expect(r.rows[0]).toEqual({ previous_write_key: null, previous_write_key_expires_at: null })
  })

  it('refuses a previous key without an expiry, and an expiry without a key', async () => {
    await expect(
      pg.query("UPDATE projects SET previous_write_key = 'wk_x' WHERE id = $1", [projectId]),
    ).rejects.toThrow(/projects_previous_write_key_pair/)
    await expect(
      pg.query('UPDATE projects SET previous_write_key_expires_at = now() WHERE id = $1', [
        projectId,
      ]),
    ).rejects.toThrow(/projects_previous_write_key_pair/)
  })

  it('refuses two projects retiring the same key', async () => {
    const r2 = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('WK rotation 2', $1, 'wk_022b', 'hash_022b') RETURNING id`,
      [SLUG_2],
    )
    const projectId2 = Number(r2.rows[0]?.id)
    await pg.query(
      "UPDATE projects SET previous_write_key = 'wk_shared', previous_write_key_expires_at = now() WHERE id = $1",
      [projectId],
    )
    await expect(
      pg.query(
        "UPDATE projects SET previous_write_key = 'wk_shared', previous_write_key_expires_at = now() WHERE id = $1",
        [projectId2],
      ),
    ).rejects.toThrow(/duplicate key/i)
  })
})
