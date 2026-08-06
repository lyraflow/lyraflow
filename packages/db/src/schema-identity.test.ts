import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChClient, createPgPool, loadMigrations, migrate } from './index.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
let projectId: number

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', 'migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Identity', 'identity-test', 'wk_identity', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-test'])
  await pg.end()
  await ch.close()
})

// An unbounded end is written as SQL NULL, never as the literal '-infinity'.
// Both satisfy the exclusion constraint and both clamp correctly through the
// view, but they are different range values, and mixing the two in one table
// makes every later query reason about two representations. NULL is the
// idiomatic Postgres unbounded bound and is what the write path in Task 3
// produces, so it is the only representation this schema accepts.
async function bind(anon: string, person: string, from: string | null, to: string | null) {
  return pg.query(
    `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, valid_range)
     VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'))`,
    [projectId, anon, person, from, to],
  )
}

describe('identity_bindings', () => {
  it('accepts a first binding that is unbounded below', async () => {
    await expect(bind('d1', 'u1', null, '2026-08-06T12:00:00Z')).resolves.toBeTruthy()
  })

  it('accepts an adjacent, non-overlapping binding for the same device', async () => {
    await expect(bind('d1', 'u2', '2026-08-06T12:00:00Z', null)).resolves.toBeTruthy()
  })

  it('rejects an overlapping range for the same device', async () => {
    await expect(bind('d1', 'u3', '2026-08-06T11:00:00Z', '2026-08-06T13:00:00Z')).rejects.toThrow(
      /identity_bindings_no_overlap|exclusion/i,
    )
  })

  it('allows the same device id in a different project without conflict', async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Other', 'identity-other', 'wk_identity_other', 'h') RETURNING id`,
    )
    const otherId = Number(other.rows[0]?.id)
    await expect(
      pg.query(
        `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, valid_range)
         VALUES ($1, 'd1', 'u9', tstzrange(NULL, NULL, '[)'))`,
        [otherId],
      ),
    ).resolves.toBeTruthy()
    await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-other'])
  })

  it('exposes the dictionary source view with finite, ClickHouse-representable bounds', async () => {
    const r = await pg.query<{ valid_from: Date; valid_to: Date }>(
      `SELECT valid_from, valid_to FROM identity_bindings_dict_src
       WHERE project_id = $1 AND anonymous_id = 'd1' ORDER BY valid_from`,
      [projectId],
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]?.valid_from.toISOString()).toBe('1970-01-01T00:00:00.000Z')
    expect(r.rows[1]?.valid_to.toISOString()).toBe('2106-02-07T06:28:15.000Z')
  })
})

describe('person_aliases', () => {
  it('stores a canonical mapping and rejects a duplicate for the same person', async () => {
    await pg.query(
      `INSERT INTO person_aliases (project_id, person_id, canonical_id) VALUES ($1, 'a', 'b')`,
      [projectId],
    )
    await expect(
      pg.query(
        `INSERT INTO person_aliases (project_id, person_id, canonical_id) VALUES ($1, 'a', 'c')`,
        [projectId],
      ),
    ).rejects.toThrow(/duplicate key/i)
  })

  it('rejects a self-alias, which would be a one-element cycle', async () => {
    await expect(
      pg.query(
        `INSERT INTO person_aliases (project_id, person_id, canonical_id) VALUES ($1, 'z', 'z')`,
        [projectId],
      ),
    ).rejects.toThrow(/person_aliases_not_self/i)
  })
})
