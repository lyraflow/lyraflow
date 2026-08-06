import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createChClient, createPgPool } from './clients.js'
import { loadMigrations, migrate } from './migrator.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

beforeAll(async () => {
  await pg.query(`
    DROP TABLE IF EXISTS ingest_counters, saved_views, segments, sessions,
                         admin_user, api_keys, projects, schema_migrations CASCADE
  `)
  const root = join(import.meta.dirname, '..', 'migrations')
  await migrate({ pg, ch, migrations: loadMigrations(root), appSchemaVersion: 999 })
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('postgres schema', () => {
  it('creates a project with a unique write key', async () => {
    await pg.query(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Demo', 'demo', 'wk_demo', 'hash')`,
    )
    await expect(
      pg.query(
        `INSERT INTO projects (name, slug, write_key, server_key_hash)
         VALUES ('Other', 'other', 'wk_demo', 'hash')`,
      ),
    ).rejects.toThrow(/duplicate key/i)
  })

  it('defaults retention to 24 months and sets a monthly quota', async () => {
    const r = await pg.query('SELECT retention_months, monthly_event_quota FROM projects LIMIT 1')
    expect(r.rows[0].retention_months).toBe(24)
    expect(Number(r.rows[0].monthly_event_quota)).toBeGreaterThan(0)
  })

  it('rejects a retention outside the supported range', async () => {
    await expect(
      pg.query("UPDATE projects SET retention_months = 0 WHERE slug = 'demo'"),
    ).rejects.toThrow(/retention/i)
  })

  it('stores a segment filter tree as jsonb with an ast_version', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    await pg.query(
      `INSERT INTO segments (project_id, name, filter_tree, ast_version)
       VALUES ($1, 'Trial users', $2, 1)`,
      [p.rows[0].id, JSON.stringify({ type: 'group', op: 'and', children: [] })],
    )
    const s = await pg.query('SELECT filter_tree, ast_version FROM segments LIMIT 1')
    expect(s.rows[0].filter_tree.op).toBe('and')
    expect(s.rows[0].ast_version).toBe(1)
  })

  it('accumulates ingest counters per project and month', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    const id = p.rows[0].id
    for (const n of [3, 4]) {
      await pg.query(
        `INSERT INTO ingest_counters (project_id, month, events_accepted)
         VALUES ($1, '2026-08-01', $2)
         ON CONFLICT (project_id, month)
         DO UPDATE SET events_accepted = ingest_counters.events_accepted + EXCLUDED.events_accepted`,
        [id, n],
      )
    }
    const c = await pg.query('SELECT events_accepted FROM ingest_counters')
    expect(Number(c.rows[0].events_accepted)).toBe(7)
  })
})
