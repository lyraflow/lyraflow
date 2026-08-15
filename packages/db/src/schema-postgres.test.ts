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
  // A hand-maintained table list here is a trap: a table added by a later
  // migration (e.g. identity_bindings, added by 003) but left off this list
  // survives the wipe. It isn't in the list, so it isn't dropped — but any
  // FK it holds to a table that WAS dropped (projects) is severed by the
  // CASCADE anyway. schema_migrations then gets dropped too, so the next
  // migrate() sees a clean ledger and reruns every migration — but
  // `CREATE TABLE IF NOT EXISTS` on the surviving table no-ops and never
  // restores the FK it just lost. The table is left silently unconstrained.
  // Dropping and recreating the whole schema removes every object
  // unconditionally, so there is never a "table survives, its FK doesn't"
  // state, and this test file needs no maintenance when new tables arrive.
  await pg.query('DROP SCHEMA public CASCADE')
  await pg.query('CREATE SCHEMA public')
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

  // 010_retention_default.sql lowered this from 24 to 13 — see that
  // migration for why (13, not 12, so year-over-year comparisons stay
  // answerable) and packages/db/src/migrations/010.test.ts for the guarantee
  // that this only ever changed the default for a NEW project, never an
  // existing row's stored value.
  //
  // 011_quota.sql dropped the monthly_event_quota DEFAULT entirely — see
  // that migration for why (unlimited is the safe direction: it must not be
  // possible for an upgrade to hand a project a cap it never opted into).
  // A NEW project, the same as an existing one, is unlimited unless an
  // operator sets a number.
  it('defaults retention to 13 months and leaves the monthly quota unlimited', async () => {
    const r = await pg.query('SELECT retention_months, monthly_event_quota FROM projects LIMIT 1')
    expect(r.rows[0].retention_months).toBe(13)
    expect(r.rows[0].monthly_event_quota).toBeNull()
  })

  it('rejects a retention outside the supported range', async () => {
    await expect(
      pg.query("UPDATE projects SET retention_months = 0 WHERE slug = 'demo'"),
    ).rejects.toThrow(/retention/i)
  })

  it('stores a segment filter tree as jsonb with an ast_version', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    await pg.query(
      `INSERT INTO segments (project_id, name, filter, ast_version)
       VALUES ($1, 'Trial users', $2, 1)`,
      [p.rows[0].id, JSON.stringify({ type: 'group', op: 'and', children: [] })],
    )
    const s = await pg.query('SELECT filter, ast_version FROM segments LIMIT 1')
    expect(s.rows[0].filter.op).toBe('and')
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

  /** The referential action Postgres will take, read from the catalogue. */
  async function deleteRuleFor(table: string, column: string): Promise<string> {
    const r = await pg.query(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage k
           ON k.constraint_name = rc.constraint_name
        WHERE k.table_name = $1 AND k.column_name = $2`,
      [table, column],
    )
    return r.rows[0]?.delete_rule
  }

  it('stores a funnel definition as jsonb with its own version column', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    await pg.query(
      `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds)
       VALUES ($1, 'signup', 1, $2, 604800)`,
      [p.rows[0].id, JSON.stringify([{ event: '$page' }, { event: 'signed_up' }])],
    )
    const f = await pg.query('SELECT steps, definition_version, window_seconds FROM funnels')
    expect(f.rows[0].steps[0].event).toBe('$page')
    expect(f.rows[0].definition_version).toBe(1)
    expect(f.rows[0].window_seconds).toBe(604800)
  })

  it('scopes a funnel name to its project', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    await expect(
      pg.query(
        `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds)
         VALUES ($1, 'signup', 1, '[]'::jsonb, 60)`,
        [p.rows[0].id],
      ),
    ).rejects.toThrow(/duplicate key/i)
  })

  it('refuses a window the compiler would refuse to run', async () => {
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    for (const seconds of [0, 2592001]) {
      await expect(
        pg.query(
          `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds)
           VALUES ($1, $2, 1, '[]'::jsonb, $3)`,
          [p.rows[0].id, `bad-window-${seconds}`, seconds],
        ),
      ).rejects.toThrow(/funnels_window_positive/i)
    }
  })

  it('keeps a funnel’s segment_id after the segment is deleted', async () => {
    // Deliberately no FK. SET NULL would erase the very fact the run path
    // needs in order to warn that the restriction is gone, and CASCADE would
    // destroy the report outright. The dangling id is resolved at run time.
    const p = await pg.query("SELECT id FROM projects WHERE slug = 'demo'")
    const seg = await pg.query(
      `INSERT INTO segments (project_id, name, filter, ast_version)
       VALUES ($1, 'doomed', '{"kind":"group","op":"and","children":[]}'::jsonb, 1)
       RETURNING id`,
      [p.rows[0].id],
    )
    await pg.query(
      `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds, segment_id)
       VALUES ($1, 'restricted', 1, '[]'::jsonb, 60, $2)`,
      [p.rows[0].id, seg.rows[0].id],
    )
    await pg.query('DELETE FROM segments WHERE id = $1', [seg.rows[0].id])
    const after = await pg.query("SELECT segment_id FROM funnels WHERE name = 'restricted'")
    expect(after.rows[0].segment_id).toBe(seg.rows[0].id)
  })

  it('does not make an earlier migration unrunnable', async () => {
    // 007_segments begins with DROP TABLE IF EXISTS segments. A dependent
    // table would make that drop fail, so replaying 007 — which the migration
    // tests do, against a shared database — would break.
    expect(await deleteRuleFor('funnels', 'segment_id')).toBeUndefined()
  })

  it('deletes a project’s funnels with the project', async () => {
    expect(await deleteRuleFor('funnels', 'project_id')).toBe('CASCADE')
  })

  it('sessions carries created_at and an index for the expiry sweep', async () => {
    const col = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'sessions' AND column_name = 'created_at'`,
    )
    expect(col.rows[0]?.is_nullable).toBe('NO')

    const idx = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'sessions' AND indexname = 'sessions_expires_at_idx'`,
    )
    expect(idx.rows).toHaveLength(1)
  })
})
