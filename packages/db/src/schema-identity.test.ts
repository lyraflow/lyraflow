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
  // Full wipe, not a hand-maintained table list: see the identical comment in
  // schema-postgres.test.ts. Also required here specifically because this
  // migration was amended in place (identity_bindings' shape changed) rather
  // than superseded by a new one — migrate() only skips versions it has
  // already recorded, so a stale `schema_migrations` row for version 3 would
  // otherwise leave the pre-amendment table shape in place.
  await pg.query('DROP SCHEMA public CASCADE')
  await pg.query('CREATE SCHEMA public')
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', 'migrations')),
    appSchemaVersion: 999,
  })
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Identity', 'identity-test', 'wk_identity', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

async function bind(anon: string, person: string, boundAt: string) {
  return pg.query(
    `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
     VALUES ($1, $2, $3, $4::timestamptz)`,
    [projectId, anon, person, boundAt],
  )
}

describe('identity_bindings', () => {
  it('accepts a bind event for a device', async () => {
    await expect(bind('d1', 'u1', '2026-08-06T12:00:00Z')).resolves.toBeTruthy()
  })

  it('accepts a second bind event for the same device at a different instant', async () => {
    await expect(bind('d1', 'u2', '2026-08-06T15:00:00Z')).resolves.toBeTruthy()
  })

  // The schema stores instants, not ranges — there is nothing here to overlap.
  // What it must still reject is two DIFFERENT events landing on the exact
  // same (device, instant) via a plain INSERT: resolving that collision
  // deterministically (LEAST(person_id)) is the write path's job (Task 3),
  // covered by the ON CONFLICT test below, not the DDL's.
  it('rejects a second, unresolved bind event at the identical (device, instant)', async () => {
    await bind('d-dup', 'u-first', '2026-08-06T09:00:00Z')
    await expect(bind('d-dup', 'u-second', '2026-08-06T09:00:00Z')).rejects.toThrow(
      /duplicate key/i,
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
        `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
         VALUES ($1, 'd1', 'u9', '2026-08-06T12:00:00Z')`,
        [otherId],
      ),
    ).resolves.toBeTruthy()
    await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-other'])
  })

  // Covers the foreign key to projects(id). It is easy to lose silently: a
  // test file elsewhere in this suite drops and recreates `projects` while
  // `identity_bindings` survives, and `CREATE TABLE IF NOT EXISTS` will not
  // restore a constraint that CASCADE already severed. Without this FK, a
  // bogus project_id is accepted instead of rejected, and deleting a project
  // stops cascading to its identity data — the same "degrades silently,
  // nothing visibly broken" failure class as the ClickHouse-infinity issue
  // the dictionary views guard against.
  it('rejects a binding whose project_id does not reference an existing project', async () => {
    await expect(
      pg.query(
        `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
         VALUES ($1, 'no-such-project', 'u-fk', '2026-08-06T12:00:00Z')`,
        [999_999_999],
      ),
    ).rejects.toThrow(/foreign key/i)
  })

  // The migration's documented write-path resolution, exercised directly at
  // the SQL level: two different people colliding on the identical instant
  // is a genuine tie with no correct answer, so it must resolve the same way
  // regardless of which of the two events is written first.
  it('resolves a same-instant collision to the lexicographically smaller person_id, regardless of write order', async () => {
    const upsert = (anon: string, person: string) =>
      pg.query(
        `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
         VALUES ($1, $2, $3, '2026-08-06T09:00:00Z')
         ON CONFLICT (project_id, anonymous_id, bound_at)
         DO UPDATE SET person_id = LEAST(identity_bindings.person_id, EXCLUDED.person_id)`,
        [projectId, anon, person],
      )

    await upsert('d-tie-a', 'zed')
    await upsert('d-tie-a', 'amy') // amy arrives second here...
    await upsert('d-tie-b', 'amy')
    await upsert('d-tie-b', 'zed') // ...and first here — same outcome either way.

    const r = await pg.query<{ anonymous_id: string; person_id: string }>(
      `SELECT anonymous_id, person_id FROM identity_bindings
       WHERE project_id = $1 AND anonymous_id IN ('d-tie-a', 'd-tie-b')
       ORDER BY anonymous_id`,
      [projectId],
    )
    expect(r.rows).toEqual([
      { anonymous_id: 'd-tie-a', person_id: 'amy' },
      { anonymous_id: 'd-tie-b', person_id: 'amy' },
    ])
  })

  it('derives the dictionary source view from bind events with finite, ClickHouse-representable bounds', async () => {
    await bind('d-view', 'u-early', '2026-08-06T10:00:00Z')
    await bind('d-view', 'u-late', '2026-08-06T16:00:00Z')

    const r = await pg.query<{ person_id: string; valid_from: Date; valid_to: Date }>(
      `SELECT person_id, valid_from, valid_to FROM identity_bindings_dict_src
       WHERE project_id = $1 AND anonymous_id = 'd-view' ORDER BY valid_from`,
      [projectId],
    )
    expect(r.rows).toHaveLength(2)
    // The earliest event owns everything before it — retroactive attachment —
    // clamped to the epoch rather than left as its own real bound_at.
    expect(r.rows[0]?.person_id).toBe('u-early')
    expect(r.rows[0]?.valid_from.toISOString()).toBe('1970-01-01T00:00:00.000Z')
    expect(r.rows[0]?.valid_to.toISOString()).toBe('2026-08-06T16:00:00.000Z')
    // The latest event is open-ended, clamped to the ClickHouse DateTime max.
    expect(r.rows[1]?.person_id).toBe('u-late')
    expect(r.rows[1]?.valid_from.toISOString()).toBe('2026-08-06T16:00:00.000Z')
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

  // Same coverage as the identity_bindings FK test above, for the other
  // table with a foreign key to projects(id).
  it('rejects an alias whose project_id does not reference an existing project', async () => {
    await expect(
      pg.query(
        `INSERT INTO person_aliases (project_id, person_id, canonical_id) VALUES ($1, 'fk-a', 'fk-b')`,
        [999_999_999],
      ),
    ).rejects.toThrow(/foreign key/i)
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
