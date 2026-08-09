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

// Own prefix, distinct from every other suite's event_id prefix in this
// package (see events/routes.test.ts's own comment for the list this joins).
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
 * partitions, regardless of what an earlier test in this file inserted or
 * (correctly) failed to drop. Several tests assert an EXACT partition/row
 * set for `projectA`/`projectB` (e.g. "refuses a run that would drop every
 * partition the project has" needs that project to have exactly one
 * partition, or the guard it is testing would not fire) -- reusing the same
 * two Postgres project rows across the whole file only works if ClickHouse
 * state is wiped between tests, since ClickHouse has no per-test transaction
 * to roll back the way Postgres tests often do.
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

  it('refuses a run that would drop every partition the project has', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      store.dropExpired(
        { projectId: projectA, retentionMonths: 1 },
        new Date('2099-01-01T00:00:00Z'),
      ),
    ).rejects.toThrow(/every partition/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  // The brief's version of this test seeds only 'old_evt', leaving the
  // project with a single, wholly-expired partition -- which correctly trips
  // Guard 3 ("never drop everything") before dry-run's own behaviour is ever
  // reached, since that guard applies regardless of dryRun (a preview that
  // silently omitted "this run would in fact be refused" would misreport
  // what a real run does). Confirmed live: running the brief's fixture as
  // written throws `refusing to drop every partition ...` instead of
  // returning a dry-run report. A `keeper_evt` inside the retained window
  // gives the project a second, surviving partition, so this test exercises
  // dry-run behaviour in isolation from Guard 3, which has its own dedicated
  // test above.
  it('a dry run reports what it would drop and drops nothing', async () => {
    const dry = new RetentionStore({ pg, ch, dryRun: true })
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'keeper_evt')
    const results = await dry.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.map((r) => r.partition)).toContain(202401)
    expect(results.every((r) => r.dropped === false)).toBe(true)
    expect(await eventNames(projectA)).toEqual(['old_evt', 'keeper_evt'])
  })

  // Same fix as the dry-run test above: 'a_evt' alone leaves project A with
  // one wholly-expired partition, which trips Guard 3 -- a guard this test
  // is not exercising -- before the real drop this test cares about ever
  // runs. 'a_keeper_evt' inside the retained window keeps A's call a normal,
  // successful drop, so this test isolates the property it is actually
  // named for: that dropping A's partitions never touches B's.
  it('never touches another project, even with an identical partition month', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'a_evt')
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'a_keeper_evt')
    await seedEventAt(projectB, '2024-01-15T00:00:00Z', 'b_evt')
    await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(await eventNames(projectB)).toEqual(['b_evt'])
  })

  // Same fix again: an 'idx_keeper_evt' inside the retained window keeps
  // project A from being left with only one, wholly-expired partition, so
  // this test isolates the device_index-drop behaviour from Guard 3.
  it('drops from device_index as well as events', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'old_evt')
    await seedEventAt(projectA, '2026-08-01T00:00:00Z', 'idx_keeper_evt')
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

  // Two mutations beyond the brief's five, aimed squarely at the guards.

  it('does not drop a partition one month newer than the boundary', async () => {
    // expiredPartitions/assertDroppable use a strict `<`/`>=` comparison, not
    // `<=`/`>`. A flipped comparison (`<=`) would drop the month immediately
    // after the boundary too -- one month too many, silently.
    await seedEventAt(projectA, '2025-08-15T00:00:00Z', 'just_after_boundary_evt')
    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.filter((r) => r.dropped)).toHaveLength(0)
    expect(await eventNames(projectA)).toEqual(['just_after_boundary_evt'])
  })

  it('the guard-3 refusal names the project id, so a shared log line is attributable', async () => {
    await seedEventAt(projectA, '2024-01-15T00:00:00Z', 'only_evt')
    await expect(
      store.dropExpired(
        { projectId: projectA, retentionMonths: 1 },
        new Date('2099-01-01T00:00:00Z'),
      ),
    ).rejects.toThrow(new RegExp(String(projectA)))
  })
})
