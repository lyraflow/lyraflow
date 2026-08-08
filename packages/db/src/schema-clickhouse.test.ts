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
  // Unconditional, like schema-postgres.test.ts: safe whether or not the
  // table currently exists, since every migration (including 001_core.sql)
  // is fully `IF NOT EXISTS` and migrate() recreates the ledger itself.
  //
  // suppressed_persons_dict_src is the one exception to "IF NOT EXISTS is
  // enough": 008_deletion_requests.sql widens it with an extra column via
  // `CREATE OR REPLACE VIEW`, and Postgres refuses to replace a view with
  // one that has fewer columns ("cannot drop columns from view"). A replay
  // of every migration from scratch runs 005's original 3-column definition
  // before 008's 4-column one — harmless against a view that does not exist
  // yet, but fatal against one this same replay (or an earlier file's) has
  // already widened. Dropping it here, alongside the ledger, guarantees 005
  // always starts from a clean slate.
  await pg.query('DROP VIEW IF EXISTS suppressed_persons_dict_src')
  await pg.query('DROP TABLE IF EXISTS schema_migrations')
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
    // FINAL applies the ReplacingMergeTree collapse deterministically at
    // query time, so this assertion doesn't depend on a background merge
    // having happened (unlike `count(DISTINCT event_id)`, which would read
    // as "deduplicated" even under a plain MergeTree with two physical rows —
    // see the Task 6 review fix report for the sanity check that proves this
    // distinction). FINAL is avoided in production query paths for cost
    // reasons; here, testing engine behaviour, it is exactly the right tool.
    const r = await rows<{ c: string }>(
      "SELECT count() AS c FROM events FINAL WHERE event_name = 'import_started'",
    )
    expect(Number(r[0]?.c)).toBe(1)
  })

  /**
   * The honest counterpart to the test above. ReplacingMergeTree collapses only
   * when the *entire* ORDER BY tuple matches — (project_id, timestamp,
   * anonymous_id, event_id) — and the server fills `timestamp` with wall-clock
   * at receipt whenever the client omits it. So an SDK that retries a 503'd
   * batch a few seconds later does NOT get its rows collapsed: it gets a second
   * physical row with the same event_id and a different timestamp.
   *
   * That is safe for correctness precisely because query paths deduplicate by
   * event_id, and this test pins both halves of that: count() sees 2, and
   * count(DISTINCT event_id) sees 1. It exists because nothing else catches the
   * difference — the dedup test above re-inserts with an identical timestamp,
   * and restart-durability.test.ts counts DISTINCT event_id, which is blind to
   * duplicates by construction.
   */
  it('keeps a retried event with a server-assigned timestamp as a second physical row, deduplicated only by event_id', async () => {
    const eventId = 'cc2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a92'
    const row = (timestamp: string) => ({
      project_id: 1,
      event_id: eventId,
      anonymous_id: 'anon-retry',
      user_id: '',
      event_name: 'retry_semantics',
      timestamp,
      received_at: timestamp,
      trusted: 0,
      properties: {},
      properties_num: {},
      country: 'DE',
    })

    // Same event_id, two different server-assigned receipt timestamps — what a
    // client that omits `timestamp` and retries actually produces.
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [row('2026-08-06 12:00:00.000'), row('2026-08-06 12:00:07.000')],
    })

    const r = await rows<{ physical: string; distinct_ids: string }>(
      `SELECT count() AS physical, count(DISTINCT event_id) AS distinct_ids
       FROM events FINAL WHERE event_name = 'retry_semantics'`,
    )
    // FINAL applies every collapse the engine is willing to make, so `physical
    // = 2` here is not a merge that merely hasn't run yet — these rows never
    // collapse. If a future schema change made the sort key timestamp-free,
    // this would drop to 1 and the test would fail loudly, which is the point.
    expect(Number(r[0]?.physical)).toBe(2)
    expect(Number(r[0]?.distinct_ids)).toBe(1)
  })

  it('partitions by project and month', async () => {
    const r = await rows<{ partition: string }>(
      "SELECT partition FROM system.parts WHERE database = 'lyraflow_test' AND table = 'events' AND active LIMIT 1",
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

  // Without this, event_schema_str_mv (the string-keyed property branch) is
  // created but never exercised by an assertion — deleting it entirely would
  // still leave the suite green, since the only prior event_schema check
  // filtered on the numeric branch (`property_key = 'rows'`).
  it('records string-valued property keys in event_schema', async () => {
    const r = await rows<{ event_name: string; property_key: string; value_kind: string }>(
      "SELECT event_name, property_key, value_kind FROM event_schema WHERE property_key = 'source'",
    )
    expect(r[0]).toMatchObject({ event_name: 'import_started', value_kind: 'string' })
  })
})
