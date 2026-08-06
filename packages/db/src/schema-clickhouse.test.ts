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

async function rows<T>(query: string): Promise<T[]> {
  const rs = await ch.query({ query, format: 'JSONEachRow' })
  return rs.json<T>()
}

beforeAll(async () => {
  for (const t of [
    'events_dead_letter',
    'device_index_mv',
    'device_index',
    'event_schema_str_mv',
    'event_schema_num_mv',
    'event_schema',
    'events',
  ]) {
    await ch.command({ query: `DROP TABLE IF EXISTS ${t}` })
  }
  // migrator.test.ts's beforeEach drops `schema_migrations` before every one
  // of its tests, including its final two (which use a fake pg client and so
  // never recreate the real table again) — so when this file runs right
  // after it in the shared suite, the table may not exist yet. Tolerate
  // that ("undefined_table", Postgres error code 42P01): migrate() below
  // recreates it via `CREATE TABLE IF NOT EXISTS` regardless.
  try {
    await pg.query('DELETE FROM schema_migrations WHERE store = $1', ['clickhouse'])
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01') throw err
  }
  const root = join(import.meta.dirname, '..', 'migrations')
  await migrate({ pg, ch, migrations: loadMigrations(root), appSchemaVersion: 999 })

  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: 1,
        event_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
        anonymous_id: 'anon-1',
        user_id: '',
        event_name: 'import_started',
        timestamp: '2026-08-06 10:00:00.000',
        received_at: '2026-08-06 10:00:01.000',
        trusted: 0,
        properties: { source: 'csv' },
        properties_num: { rows: 4021 },
        country: 'DE',
      },
      {
        project_id: 1,
        event_id: 'aa2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a91',
        anonymous_id: 'anon-1',
        user_id: 'u-1',
        event_name: '$identify',
        timestamp: '2026-08-06 11:00:00.000',
        received_at: '2026-08-06 11:00:01.000',
        trusted: 0,
        properties: {},
        properties_num: {},
        country: 'TR',
      },
    ],
  })
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('clickhouse schema', () => {
  it('stores properties in the two typed maps', async () => {
    const r = await rows<{ s: string; n: number }>(
      "SELECT properties['source'] AS s, properties_num['rows'] AS n FROM events WHERE event_name = 'import_started'",
    )
    expect(r[0]).toEqual({ s: 'csv', n: 4021 })
  })

  it('deduplicates a replayed event with the same id and payload', async () => {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: 1,
          event_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
          anonymous_id: 'anon-1',
          user_id: '',
          event_name: 'import_started',
          timestamp: '2026-08-06 10:00:00.000',
          received_at: '2026-08-06 10:00:09.000',
          trusted: 0,
          properties: { source: 'csv' },
          properties_num: { rows: 4021 },
          country: 'DE',
        },
      ],
    })
    const r = await rows<{ c: string }>(
      "SELECT count(DISTINCT event_id) AS c FROM events WHERE event_name = 'import_started'",
    )
    expect(Number(r[0]?.c)).toBe(1)
  })

  it('partitions by project and month', async () => {
    const r = await rows<{ partition: string }>(
      "SELECT partition FROM system.parts WHERE table = 'events' AND active LIMIT 1",
    )
    expect(r[0]?.partition).toContain('202608')
  })

  it('populates device_index with lifecycle bounds and latest context', async () => {
    const r = await rows<{ first_seen: string; last_seen: string; latest_country: string }>(`
      SELECT minMerge(first_seen) AS first_seen,
             maxMerge(last_seen)  AS last_seen,
             argMaxMerge(latest_country) AS latest_country
      FROM device_index WHERE project_id = 1 AND anonymous_id = 'anon-1'
    `)
    expect(r[0]?.first_seen).toContain('10:00:00')
    expect(r[0]?.last_seen).toContain('11:00:00')
    expect(r[0]?.latest_country).toBe('TR')
  })

  it('records observed event names and property keys in event_schema', async () => {
    const r = await rows<{ event_name: string; property_key: string; value_kind: string }>(
      "SELECT event_name, property_key, value_kind FROM event_schema WHERE property_key = 'rows'",
    )
    expect(r[0]).toMatchObject({ event_name: 'import_started', value_kind: 'number' })
  })
})
