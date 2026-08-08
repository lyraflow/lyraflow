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

const SLUG = 'deletion-request-ids-test'
let projectId: number

beforeAll(async () => {
  // Cleaned at the TOP, not only in afterAll — this file shares
  // `deletion_requests` with several others and has to be safe run standalone,
  // repeatedly, after a crashed run.
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Deletion Request Ids', $1, 'wk_delreq_ids', 'h') RETURNING id`,
    [SLUG],
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.end()
  await ch.close()
})

describe('deletion_requests.person_ids', () => {
  it('is a NOT NULL text[] defaulting to the empty array', async () => {
    const r = await pg.query<{
      data_type: string
      udt_name: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'deletion_requests' AND column_name = 'person_ids'`,
    )
    const col = r.rows[0]
    expect(col?.data_type).toBe('ARRAY')
    expect(col?.udt_name).toBe('_text')
    expect(col?.is_nullable).toBe('NO')
    // The default is the whole upgrade story: a row written before this
    // migration carries `{}`, and the purge worker reads an EMPTY array as
    // "no restriction" so an in-flight deletion still gets carried out
    // (009_deletion_request_ids.sql argues why that direction and not the
    // other). A default of NULL, or no default at all, would break the
    // migration itself against a table that already has rows.
    expect(col?.column_default).toMatch(/'\{\}'/)
  })

  it('defaults an insert that names no ids to the empty array, never null', async () => {
    // The exact shape a pre-009 row has after the upgrade: `person_ids` never
    // mentioned by the writer. `DeletionStore.toRequest` treats null and
    // empty identically anyway, but the column being NOT NULL is what keeps
    // that from ever mattering.
    const r = await pg.query<{ person_ids: string[] }>(
      `INSERT INTO deletion_requests (project_id, person_id)
       VALUES ($1, 'legacy-person') RETURNING person_ids`,
      [projectId],
    )
    expect(r.rows[0]?.person_ids).toEqual([])
  })

  it('round-trips a recorded id set', async () => {
    const ids = ['canonical-1', 'merged-away-1', 'device-1']
    const r = await pg.query<{ person_ids: string[] }>(
      `INSERT INTO deletion_requests (project_id, person_id, person_ids)
       VALUES ($1, 'canonical-1', $2) RETURNING person_ids`,
      [projectId, ids],
    )
    expect(r.rows[0]?.person_ids).toEqual(ids)
  })
})
