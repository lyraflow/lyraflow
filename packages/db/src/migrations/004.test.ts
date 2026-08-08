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

async function q(query: string): Promise<Array<Record<string, unknown>>> {
  const rs = await ch.query({ query, format: 'JSONEachRow' })
  return rs.json()
}

beforeAll(async () => {
  // Drop this migration's objects and the ledger together, in that order.
  // Dropping the tables alone would not be enough: migrate() skips any version
  // already recorded in schema_migrations, so a stale row for 4 would leave
  // person_traits absent and every assertion below failing for the wrong
  // reason. Every migration is fully IF NOT EXISTS, so replaying the whole
  // sequence against the surviving tables is a no-op for the rest of them.
  //
  // Materialised views are dropped before their target: they are triggers on
  // INSERT, never backfills, so a view left pointing at a recreated table
  // would silently contribute nothing until the next insert.
  for (const t of ['person_traits_str_mv', 'person_traits_num_mv', 'person_traits']) {
    await ch.command({ query: `DROP TABLE IF EXISTS ${t}` })
  }
  // suppressed_persons_dict_src is the one Postgres object that is NOT
  // safely replayable by "IF NOT EXISTS" alone: 008_deletion_requests.sql
  // widens it with `CREATE OR REPLACE VIEW`, which Postgres refuses once the
  // live view already carries the extra column ("cannot drop columns from
  // view") — exactly the state an earlier full replay in this same,
  // fileParallelism-false suite can leave it in. Dropped here so 005's
  // original, unmodified 3-column definition always has a clean slate to
  // replay against.
  await pg.query('DROP VIEW IF EXISTS suppressed_persons_dict_src')
  await pg.query('DROP TABLE IF EXISTS schema_migrations')
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '..', '..', 'migrations')),
    appSchemaVersion: 999,
  })
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('person_traits', () => {
  it('keeps the newest value per trait key, not per person', async () => {
    // Two identifies for one device, each setting a DIFFERENT key. A
    // whole-row-replacing engine keeps only the second; this must keep both.
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: 9001,
          event_id: '4a000001-0000-4000-8000-000000000001',
          anonymous_id: 'dev-1',
          user_id: 'u-1',
          event_name: '$identify',
          timestamp: '2026-01-01 00:00:00.000',
          received_at: '2026-01-01 00:00:00.000',
          trusted: 1,
          properties: { plan: 'trial' },
          properties_num: {},
        },
        {
          project_id: 9001,
          event_id: '4a000002-0000-4000-8000-000000000002',
          anonymous_id: 'dev-1',
          user_id: 'u-1',
          event_name: '$identify',
          timestamp: '2026-01-02 00:00:00.000',
          received_at: '2026-01-02 00:00:00.000',
          trusted: 1,
          properties: { role: 'admin' },
          properties_num: {},
        },
      ],
    })

    const rows = await q(`
      SELECT trait_key, argMaxMerge(value_str) AS v
      FROM person_traits WHERE project_id = 9001 AND anonymous_id = 'dev-1'
      GROUP BY trait_key ORDER BY trait_key`)

    expect(rows).toEqual([
      { trait_key: 'plan', v: 'trial' },
      { trait_key: 'role', v: 'admin' },
    ])
  })

  it('takes the latest value when the same key is set twice', async () => {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: 9002,
          event_id: '4a000003-0000-4000-8000-000000000003',
          anonymous_id: 'dev-2',
          user_id: 'u-2',
          event_name: '$identify',
          timestamp: '2026-01-01 00:00:00.000',
          received_at: '2026-01-01 00:00:00.000',
          trusted: 1,
          properties: { plan: 'trial' },
          properties_num: {},
        },
        {
          project_id: 9002,
          event_id: '4a000004-0000-4000-8000-000000000004',
          anonymous_id: 'dev-2',
          user_id: 'u-2',
          event_name: '$identify',
          timestamp: '2026-06-01 00:00:00.000',
          received_at: '2026-06-01 00:00:00.000',
          trusted: 1,
          properties: { plan: 'pro' },
          properties_num: {},
        },
      ],
    })

    const rows = await q(`
      SELECT argMaxMerge(value_str) AS v FROM person_traits
      WHERE project_id = 9002 AND anonymous_id = 'dev-2' AND trait_key = 'plan'`)

    expect(rows).toEqual([{ v: 'pro' }])
  })

  it('records numeric traits with has_num set', async () => {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: 9003,
          event_id: '4a000005-0000-4000-8000-000000000005',
          anonymous_id: 'dev-3',
          user_id: 'u-3',
          event_name: '$identify',
          timestamp: '2026-01-01 00:00:00.000',
          received_at: '2026-01-01 00:00:00.000',
          trusted: 1,
          properties: {},
          properties_num: { seats: 12 },
        },
      ],
    })

    const rows = await q(`
      SELECT argMaxMerge(value_num) AS n, argMaxMerge(has_num) AS h
      FROM person_traits
      WHERE project_id = 9003 AND anonymous_id = 'dev-3' AND trait_key = 'seats'`)

    expect(rows).toEqual([{ n: 12, h: 1 }])
  })

  it('ignores events that are not $identify', async () => {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: 9004,
          event_id: '4a000006-0000-4000-8000-000000000006',
          anonymous_id: 'dev-4',
          user_id: 'u-4',
          event_name: 'signed_up',
          timestamp: '2026-01-01 00:00:00.000',
          received_at: '2026-01-01 00:00:00.000',
          trusted: 1,
          properties: { plan: 'pro' },
          properties_num: {},
        },
      ],
    })

    const rows = await q('SELECT count() AS c FROM person_traits WHERE project_id = 9004')
    expect(rows).toEqual([{ c: '0' }])
  })
})
