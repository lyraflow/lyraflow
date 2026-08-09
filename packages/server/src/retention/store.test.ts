import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { retentionBoundary, toYYYYMM } from './boundary.js'
import { type DropResult, RETENTION_TABLES, RetentionStore, type RetentionTarget } from './store.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const SLUG_A = 'ret-store-a'
const SLUG_B = 'ret-store-b'

// Intended prefix `re000000-`, but `r` is not a hex digit: ClickHouse's UUID
// parser silently coerces it to `fe000000-` on insert (confirmed live --
// `SELECT event_id` reads back `fe000000-0000-...`, not `re000000-...`).
// Harmless here (still a fixed, file-local prefix, still distinct from every
// other suite's), but the REAL prefix a future suite must avoid colliding
// with is `fe000000-`, not `re000000-`.
let seedCounter = 0
const eventId = () => {
  seedCounter += 1
  return `re000000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`
}

let projectA: number
let projectB: number

/**
 * `dropOnePartition` is `protected`, not exported -- Guard 2 (assert at the
 * moment of the drop) is only provable by calling it directly with a
 * partition that was never filtered through `expiredPartitions`, so this
 * subclass exists purely to reach it from a test. Every other test in this
 * file uses a plain `RetentionStore`; only the boundary-month test below
 * needs this one.
 */
class ForcedDropStore extends RetentionStore {
  forceDrop(projectId: number, partition: number, boundaryMonth: number): Promise<DropResult> {
    return this.dropOnePartition(projectId, 'events', partition, boundaryMonth)
  }
}

async function dropWithForcedPartition(
  store: ForcedDropStore,
  projectId: number,
  partition: number,
  now: Date,
): Promise<DropResult> {
  const boundary = retentionBoundary(now, 13)
  return store.forceDrop(projectId, partition, toYYYYMM(boundary))
}

async function makeProject(slug: string, name: string, retentionMonths: number): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, retention_months)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_hash_${slug}`, retentionMonths],
  )
  return Number(r.rows[0]?.id)
}

/** ClickHouse DateTime64(3) literal from an ISO-8601 string. */
const chAt = (iso: string) => iso.replace('T', ' ').replace('Z', '')

async function seedEventAt(
  projectId: number,
  isoTimestamp: string,
  eventName: string,
): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: '',
        user_id: `ret-store-user-${seedCounter}`,
        event_name: eventName,
        timestamp: chAt(isoTimestamp),
        received_at: chAt(isoTimestamp),
        trusted: 1,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

async function eventNames(projectId: number): Promise<string[]> {
  const rs = await ch.query({
    query: 'SELECT event_name FROM events WHERE project_id = {p:UInt32} ORDER BY timestamp ASC',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ event_name: string }>()
  return rows.map((r) => r.event_name)
}

/** `device_index.month` as `YYYY-MM-DD` text, for the device_index-drop test. */
async function deviceIndexMonths(projectId: number): Promise<string[]> {
  const rs = await ch.query({
    query:
      'SELECT DISTINCT toString(month) AS month FROM device_index WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ month: string }>()
  return rows.map((r) => r.month)
}

/**
 * Drops every partition `projectId` currently has, in every retention table,
 * WITHOUT going through `RetentionStore`'s guards -- this is test-fixture
 * cleanup, not the code under test. Called at the top of every `it` (via
 * `beforeEach`) so each test starts from a project with zero ClickHouse
 * partitions, regardless of what an earlier test in this file inserted.
 * Reusing the same two Postgres project rows across the whole file only
 * works if ClickHouse state is wiped between tests, since ClickHouse has no
 * per-test transaction to roll back the way Postgres tests often do.
 */
async function wipeProjectPartitions(projectId: number): Promise<void> {
  for (const table of RETENTION_TABLES) {
    const rs = await ch.query({
      query: `SELECT DISTINCT partition FROM system.parts
              WHERE database = currentDatabase() AND table = {table:String} AND active`,
      query_params: { table },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ partition: string }>()
    for (const row of rows) {
      const match = /^\((\d+),(\d+)\)$/.exec(row.partition)
      if (!match) continue
      const [, projectIdText, monthText] = match
      if (Number(projectIdText) !== projectId) continue
      await ch.command({
        query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
        query_params: { p: projectId, m: Number(monthText) },
      })
    }
  }
}

/** `events_dead_letter` has no per-test wipe (only one test below writes to it). */
async function wipeDeadLetter(projectId: number): Promise<void> {
  await ch.command({
    query: 'ALTER TABLE events_dead_letter DELETE WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    clickhouse_settings: { mutations_sync: '1' },
  })
}

/**
 * Run at the TOP of beforeAll, not only in afterAll -- per the branch's
 * live-database rule, so a previous crashed run can never leave rows this
 * run trips over. Mirrors events/routes.test.ts's `cleanup()`.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  for (const id of ids) {
    await wipeProjectPartitions(id)
    await wipeDeadLetter(id)
  }
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

let store: ForcedDropStore

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  await cleanup()

  projectA = await makeProject(SLUG_A, 'RetentionStoreA', 13)
  projectB = await makeProject(SLUG_B, 'RetentionStoreB', 3)

  store = new ForcedDropStore({ pg, ch, dryRun: false })
})

beforeEach(async () => {
  await wipeProjectPartitions(projectA)
  await wipeProjectPartitions(projectB)
})

afterAll(async () => {
  await wipeProjectPartitions(projectA)
  await wipeProjectPartitions(projectB)
  await wipeDeadLetter(projectA)
  await wipeDeadLetter(projectB)
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
  await pg.end()
  await ch.close()
})

// Fixed, not `new Date()` -- every test below passes this explicitly to
// `dropExpired`, which is Guard 1 itself (the store never reads the clock).
// Chosen so `retentionBoundary(NOW, 13)` lands on 2025-07-01 (boundary month
// 202507): a month strictly after the '2024-01-15' fixture used throughout
// this file, strictly before the '2026-08-01' one, and exactly equal to the
// '2025-07-15' one's own partition month -- giving every test below a fixed,
// non-drifting three-way split (expired / boundary / kept) without each test
// having to recompute it.
const NOW = new Date('2026-08-01T00:00:00.000Z')

describe('RetentionStore', () => {
  it('drops only partitions strictly older than the boundary, and leaves the neighbour byte-intact', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    await seedEventAt(projectA, '2025-07-15T00:00:00Z', 'boundary_evt')
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'recent_evt')

    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)

    expect(results.filter((r) => r.dropped).map((r) => r.partition)).toContain(202401)
    expect(await eventNames(projectA)).toEqual(['boundary_evt', 'recent_evt'])
  })

  it('refuses to drop a partition at the boundary month itself', async () => {
    await seedEventAt(projectA, '2025-07-15T00:00:00Z', 'boundary_evt')
    await expect(dropWithForcedPartition(store, projectA, 202507, NOW)).rejects.toThrow(
      /not older than retention boundary month/i,
    )
    expect(await eventNames(projectA)).toEqual(['boundary_evt'])
  })

  // The guard this replaced ("never drop every partition a project has")
  // refused a project whose data was entirely and legitimately expired --
  // forever, once per cycle -- and its stated justification ("a real
  // boundary always keeps at least the current month") was false for a
  // dormant project, which has no current-month partition at all. Review
  // established that a negative `retentionMonths` is the only input that
  // actually produces "everything expired," and it does so by putting the
  // boundary in the future -- exactly what this assertion catches instead.
  it('refuses a boundary in the future, which is what a negative retention produces', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: -1 }, NOW),
    ).rejects.toThrow(/boundary .* in the future/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('reclaims a dormant project whose partitions have all expired', async () => {
    // A churned account is exactly the population disk retention exists to
    // free. The old "never drop everything" rule refused this forever, and
    // a dormant project has no current-month partition to save it.
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.filter((r) => r.dropped).map((r) => r.partition)).toContain(202401)
    expect(await eventNames(projectA)).toEqual([])
  })

  // A dry run must be refused for exactly the same reason a real run would
  // be -- a preview that silently omitted "this run would in fact be
  // refused" misreports what a real run does.
  it('a dry run is also refused when the boundary would be in the future', async () => {
    const dry = new RetentionStore({ pg, ch, dryRun: true })
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      dry.dropExpired({ projectId: projectA, retentionMonths: -1 }, NOW),
    ).rejects.toThrow(/boundary .* in the future/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('the future-boundary refusal names the project id, so a shared log line is attributable', async () => {
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: -1 }, NOW),
    ).rejects.toThrow(new RegExp(String(projectA)))
  })

  // The future-boundary check alone cannot catch this: `retentionMonths: 0`
  // makes `retentionBoundary` land exactly on the current month, which is
  // NOT in the future relative to `now` -- so without a separate range
  // check, a zero would silently pass through and simply expire nothing
  // (the current month is never droppable), a different but equally silent
  // wrong answer from a caller that should have been refused outright.
  it('refuses retentionMonths=0, which the future-boundary check alone cannot catch', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 0 }, NOW),
    ).rejects.toThrow(/retentionMonths 0 is not an integer/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  // `dropExpired` takes an arbitrary `RetentionTarget`, not only ones read
  // through the Postgres column's `CHECK (retention_months BETWEEN 1 AND
  // 120)`. A non-finite value clears the future-boundary check silently
  // (`NaN > nowMonth` is `false`) and, left unvalidated, makes
  // `expiredPartitions` return `[]` every time -- a clean, silent, zero-drop
  // "success" a scheduler cannot distinguish from a healthy run with
  // nothing left to expire.
  it('refuses a non-finite retentionMonths instead of silently dropping nothing', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: Number.NaN }, NOW),
    ).rejects.toThrow(/retentionMonths NaN is not an integer/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('accepts retentionMonths at both ends of the permitted range, 1 and 120, without a false refusal', async () => {
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'r1_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 1 }, NOW),
    ).resolves.toBeDefined()
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 120 }, NOW),
    ).resolves.toBeDefined()
    // Neither call had anything genuinely expired to drop (the fixture sits
    // in the current month), so the one row survives both.
    expect(await eventNames(projectA)).toEqual(['r1_evt'])
  })

  it('a dry run reports what it would drop and drops nothing', async () => {
    const dry = new RetentionStore({ pg, ch, dryRun: true })
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    const results = await dry.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.map((r) => r.partition)).toContain(202401)
    expect(results.every((r) => r.dropped === false)).toBe(true)
    expect(await eventNames(projectA)).toEqual(['old_evt'])
  })

  it('never touches another project, even with an identical partition month', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'a_evt')
    await seedEventAt(projectB, '2024-01-15T00:00:00Z', 'b_evt')
    await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(await eventNames(projectB)).toEqual(['b_evt'])
  })

  it('drops from device_index as well as events', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    expect(await deviceIndexMonths(projectA)).toContain('2024-01-01')
    await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(await deviceIndexMonths(projectA)).not.toContain('2024-01-01')
  })

  it('is idempotent — a second run drops nothing and does not throw', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'recent_evt')
    const first = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(first.filter((r) => r.dropped)).not.toHaveLength(0)
    const second = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(second.filter((r) => r.dropped)).toHaveLength(0)
    expect(await eventNames(projectA)).toEqual(['recent_evt'])
  })

  it('returns every project with its own retention_months', async () => {
    const targets = await store.listProjects()
    const a = targets.find((t: RetentionTarget) => t.projectId === projectA)
    const b = targets.find((t: RetentionTarget) => t.projectId === projectB)
    expect(a?.retentionMonths).toBe(13)
    expect(b?.retentionMonths).toBe(3)
  })

  // Regression test for the old "never drop everything" guard's other
  // failure: it compared `expired.length === allPartitions.length`, which is
  // `0 === 0` -- true -- for a brand-new project with zero partitions in a
  // table. Brand-new projects are routine, and Task 3 iterates every
  // project, so this must never throw. The redesigned checks depend on
  // neither the partition list nor its length, so this now simply does
  // nothing and returns cleanly.
  it('does not refuse a project with zero partitions in any retention table', async () => {
    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results).toEqual([])
  })

  // `listPartitions` scopes its `system.parts` query to `currentDatabase()`
  // because that table is server-wide, not scoped to the client's own
  // database. A second database on the same server, with its own same-named
  // `events` table using the identical `(project_id, month)` partition
  // shape, is exactly the case that filter exists to exclude -- without it,
  // a foreign database's row for this project would inflate the partition
  // list this store believes it has.
  it('does not let a same-named table in a foreign database inflate the partition list', async () => {
    const foreignDb = 'ret_store_foreign_probe'
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${foreignDb}` })
    try {
      await ch.command({
        query: `CREATE TABLE IF NOT EXISTS ${foreignDb}.events (
                  project_id UInt32, ts DateTime64(3, 'UTC')
                ) ENGINE = MergeTree
                PARTITION BY (project_id, toYYYYMM(ts))
                ORDER BY (project_id, ts)`,
      })
      // A month with no real local counterpart for projectA, so its
      // presence (or absence) in the result is unambiguous.
      await ch.insert({
        table: `${foreignDb}.events`,
        format: 'JSONEachRow',
        values: [{ project_id: projectA, ts: chAt('2020-01-15T00:00:00Z') }],
      })

      const months = await store.listPartitions(projectA, 'events')
      expect(months).not.toContain(202001)
    } finally {
      await ch.command({ query: `DROP TABLE IF EXISTS ${foreignDb}.events` })
      await ch.command({ query: `DROP DATABASE IF EXISTS ${foreignDb}` })
    }
  })

  // `events_dead_letter` (`PARTITION BY toYYYYMM(received_at)`) is the one
  // table on the server with a SINGLE-column partition key, so
  // `system.parts.partition` renders it as a bare `"202401"`, not the
  // `"(project_id,month)"` tuple form every `RETENTION_TABLES` entry uses.
  // `listPartitions` must throw on that shape, not silently skip it: a
  // skipped row makes `listPartitions` under-report a project's true
  // partition set, and there is no downstream guard left that would ever
  // notice the shortfall.
  it('throws rather than silently skipping an unparseable partition value', async () => {
    await ch.insert({
      table: 'events_dead_letter',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          received_at: chAt('2024-01-15T00:00:00Z'),
          reason: 'ret_store_probe',
          detail: '',
          payload: '',
        },
      ],
    })
    await expect(store.listPartitions(projectA, 'events_dead_letter')).rejects.toThrow(
      /unexpected partition format/i,
    )
  })
})
