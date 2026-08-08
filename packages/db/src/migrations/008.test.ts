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
  await pg.query('DELETE FROM projects WHERE slug = $1', ['deletion-requests-test'])
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Deletion Requests', 'deletion-requests-test', 'wk_delreq', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['deletion-requests-test'])
  await pg.end()
  await ch.close()
})

describe('deletion_requests table', () => {
  it('has the exact columns and nullability the migration declares', async () => {
    const cols = await pg.query<{
      column_name: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'deletion_requests'
       ORDER BY ordinal_position`,
    )
    const byName = new Map(cols.rows.map((c) => [c.column_name, c]))

    expect(byName.get('id')?.is_nullable).toBe('NO')
    expect(byName.get('project_id')?.is_nullable).toBe('NO')
    expect(byName.get('person_id')?.is_nullable).toBe('NO')
    expect(byName.get('requested_at')?.is_nullable).toBe('NO')
    expect(byName.get('requested_at')?.column_default).toMatch(/now\(\)/)
    expect(byName.get('claimed_at')?.is_nullable).toBe('YES')
    expect(byName.get('completed_at')?.is_nullable).toBe('YES')
    expect(byName.get('attempts')?.is_nullable).toBe('NO')
    expect(byName.get('attempts')?.column_default).toMatch(/0/)
    expect(byName.get('last_error')?.is_nullable).toBe('YES')

    // The WHOLE table as it stands after every migration that touches it, not
    // only the columns 008 itself declares — that is the point of an
    // exhaustive list, and narrowing it to 008's own columns would let a
    // later migration add a column here unnoticed. `person_ids` comes from
    // 009_deletion_request_ids.sql; its own contract (the array type, and the
    // `'{}'` default that means "unrestricted") is pinned in 009.test.ts.
    expect([...byName.keys()].sort()).toEqual(
      [
        'id',
        'project_id',
        'person_id',
        'person_ids',
        'requested_at',
        'claimed_at',
        'completed_at',
        'attempts',
        'last_error',
      ].sort(),
    )
  })

  it('cascades on project deletion', async () => {
    const other = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Doomed', 'deletion-requests-doomed', 'wk_delreq_doomed', 'h') RETURNING id`,
    )
    const doomed = Number(other.rows[0]?.id)
    await pg.query(
      `INSERT INTO deletion_requests (project_id, person_id) VALUES ($1, 'person-doomed')`,
      [doomed],
    )
    await pg.query('DELETE FROM projects WHERE id = $1', [doomed])
    const r = await pg.query<{ c: string }>(
      'SELECT count(*) AS c FROM deletion_requests WHERE project_id = $1',
      [doomed],
    )
    expect(Number(r.rows[0]?.c)).toBe(0)
  })

  it('exposes suppressed_at through the view and round-trips a known instant', async () => {
    const at = new Date('2026-01-15T12:34:56Z')
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id, suppressed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, person_id) DO UPDATE SET suppressed_at = EXCLUDED.suppressed_at`,
      [projectId, 'sup-roundtrip', at],
    )
    const r = await pg.query<{ suppressed_at: Date; suppressed: number }>(
      `SELECT suppressed_at, suppressed FROM suppressed_persons_dict_src
       WHERE project_id = $1 AND person_id = $2`,
      [projectId, 'sup-roundtrip'],
    )
    expect(r.rows[0]?.suppressed).toBe(1)
    expect(r.rows[0]?.suppressed_at?.getTime()).toBe(at.getTime())
  })

  it('clamps an infinite suppressed_at to the ClickHouse DateTime bound instead of erroring', async () => {
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id, suppressed_at)
       VALUES ($1, $2, 'infinity')
       ON CONFLICT (project_id, person_id) DO UPDATE SET suppressed_at = EXCLUDED.suppressed_at`,
      [projectId, 'sup-infinity'],
    )
    const r = await pg.query<{ suppressed_at: Date }>(
      `SELECT suppressed_at FROM suppressed_persons_dict_src
       WHERE project_id = $1 AND person_id = $2`,
      [projectId, 'sup-infinity'],
    )
    expect(r.rows[0]?.suppressed_at?.toISOString()).toBe('2106-02-07T06:28:15.000Z')
  })
})
