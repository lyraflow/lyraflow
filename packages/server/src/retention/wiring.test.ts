// This file proves what app.ts's own wiring adds on top of RetentionStore
// and RetentionWorker (both already covered exhaustively by store.test.ts
// and worker.test.ts): that a real drop, driven through the real app, (1)
// logs one `info` line per partition actually dropped, naming project,
// table and partition (Guard 5 — see app.ts), and (2) moves the two
// `/metrics` series app.ts wires from `onRun`. It drives the worker through
// `runOnce()` directly, never its own timer — see app.ts's own comment on
// why `buildApp` never starts it, and privacy/end-to-end.test.ts for the
// identical discipline applied to PurgeWorker.
//
// `runOnce()` below is a WHOLE-DATABASE sweep: `app.deps.retention` was
// built from the real `RetentionStore`, whose `listProjects()` reads every
// row in the shared `projects` table, not merely this file's own fixture —
// so every call in this file issues real `ALTER TABLE ... DROP PARTITION`
// drops against whatever ANY project in the shared test database currently
// has expired. That is only safe because of two facts that are NOT local to
// this file and must keep holding for every file in the suite: (1) the root
// vitest config runs with `fileParallelism: false`, so no other test's
// `beforeAll`/`it` can be mutating ClickHouse concurrently while a sweep
// here is in flight, and (2) no other test file in the suite seeds an event
// with a month-shifted (backdated) timestamp the way store.test.ts's and
// this file's own fixtures do — every other file's fixtures land in the
// current month, which no `retentionMonths` this codebase accepts (1-120)
// can ever call expired. If either fact stops holding, a sweep here could
// silently start dropping another test file's fixture data.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const SLUG = 'retention-wiring'
const SERVER_KEY = 'sk_ret_wiring'

let projectId: number
let app: FastifyInstance

// Captured once, from the real process clock, when this file loads —
// dropExpired refuses any `now` more than a day from the real process clock
// (see store.ts), and the wired worker's own `now` (app.ts) IS the real
// process clock, so every fixture below is anchored relative to it rather
// than to a fixed literal that would eventually drift out of that window.
const NOW = new Date()

/** Mirrors store.test.ts's own `monthsAgo` — see that file for the day-clamp reasoning. */
function monthsAgo(n: number): string {
  const day = Math.min(15, NOW.getUTCDate())
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, day)).toISOString()
}

const chAt = (iso: string) => iso.replace('T', ' ').replace('Z', '')

let seedCounter = 0
const eventId = () => {
  seedCounter += 1
  // Distinct prefix from store.test.ts/worker.test.ts's own fixtures —
  // this file shares the same ClickHouse database with the rest of the
  // suite.
  return `fe200000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`
}

/** `monthsAgoN` is which expired month to seed into — distinct values land in distinct partitions. */
async function seedOldEvent(monthsAgoN = 14): Promise<void> {
  seedCounter += 1
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: '',
        user_id: `retention-wiring-user-${seedCounter}`,
        event_name: 'old_evt',
        timestamp: chAt(monthsAgo(monthsAgoN)),
        received_at: chAt(monthsAgo(monthsAgoN)),
        trusted: 1,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

async function partitionsDroppedTotal(): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/metrics' })
  const line = res.body
    .split('\n')
    .find((l) => l.startsWith('lyraflow_retention_partitions_dropped_total '))
  return Number(line?.split(' ')[1])
}

/**
 * A person whose ENTIRE history — a `track` event and an `$identify` event
 * carrying a trait — sits in one expired month. Both land in the same
 * `events`/`device_index` partition, so a single retention drop removes
 * every event this person ever has. The `$identify` event's properties are
 * still materialised into `person_traits` at INSERT time by that table's own
 * materialised view (004_person_traits.sql) — a step that already happened
 * and is not undone by a later partition drop, since `person_traits` is not
 * one of `RETENTION_TABLES`. This is the exact fixture shape the README's
 * *Retention* section describes: traits survive, physically, after every
 * event that produced them is gone.
 */
async function seedFullyExpiredPersonWithTraits(userId: string, monthsAgoN: number): Promise<void> {
  const ts = chAt(monthsAgo(monthsAgoN))
  seedCounter += 1
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: '',
        user_id: userId,
        event_name: 'sar_track_evt',
        timestamp: ts,
        received_at: ts,
        trusted: 1,
        properties: {},
        properties_num: {},
      },
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: '',
        user_id: userId,
        // The ingest path's own eventName() assigns this for an identify
        // payload (ingest/row.ts) — matched literally here since this insert
        // bypasses ingest entirely, straight into ClickHouse.
        event_name: '$identify',
        timestamp: ts,
        received_at: ts,
        trusted: 1,
        properties: { email: 'person@example.test' },
        properties_num: {},
      },
    ],
  })
}

async function wipePartitions(pid: number): Promise<void> {
  for (const table of ['events', 'device_index']) {
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
      const [, pidText, monthText] = match
      if (Number(pidText) !== pid) continue
      await ch.command({
        query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
        query_params: { p: pid, m: Number(monthText) },
      })
    }
  }
}

async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
  for (const row of existing.rows) {
    await wipePartitions(Number(row.id))
    // person_traits is NOT in RETENTION_TABLES (that is the whole point of
    // the SAR test above), so wipePartitions never touches it — cleaned up
    // separately here instead.
    await ch.command({
      query: 'ALTER TABLE person_traits DELETE WHERE project_id = {p:UInt32}',
      query_params: { p: Number(row.id) },
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, retention_months)
     VALUES ('Retention Wiring', $1, 'wk_ret_wiring', $2, 13) RETURNING id`,
    [SLUG, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(r.rows[0]?.id)

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
  } as NodeJS.ProcessEnv)

  const readiness = new Readiness()
  readiness.markReady()
  // buildApp deliberately does not start() the retention worker (see
  // app.ts) — this file drives it itself, through runOnce(), never through
  // its own timer.
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

beforeEach(async () => {
  await wipePartitions(projectId)
})

describe('retention wiring (app.ts)', () => {
  it('starts with a zero, not-yet-run metrics state', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.body).toContain('lyraflow_retention_last_run_timestamp_seconds 0')
    expect(res.body).toContain('lyraflow_retention_partitions_dropped_total 0')
  })

  it('drops the expired partition through the real app, logs one line per drop, and moves the metrics', async () => {
    await seedOldEvent()

    const infoSpy = vi.spyOn(app.log, 'info')
    const beforeRun = Date.now()

    await app.deps.retention.runOnce()

    // Guard 5: one `info` line per ACTUAL drop, naming project/table/partition.
    const dropLines = infoSpy.mock.calls.filter(
      (call): call is [Record<string, unknown>, string] =>
        call[1] === 'retention dropped partition',
    )
    expect(dropLines.length).toBeGreaterThan(0)
    for (const [fields] of dropLines) {
      expect(fields.projectId).toBe(projectId)
      expect(typeof fields.table).toBe('string')
      expect(typeof fields.partition).toBe('number')
    }
    // RETENTION_TABLES is ['events', 'device_index'] and the seeded event
    // populates device_index via its materialised view, so both tables
    // should have an expired partition dropped and logged.
    const tables = dropLines.map(([fields]) => fields.table)
    expect(tables).toContain('events')
    expect(tables).toContain('device_index')

    infoSpy.mockRestore()

    // The partition is genuinely gone, not merely reported as gone.
    const remaining = await ch.query({
      query: 'SELECT count() AS c FROM events WHERE project_id = {p:UInt32}',
      query_params: { p: projectId },
      format: 'JSONEachRow',
    })
    const remainingRows = await remaining.json<{ c: string }>()
    expect(remainingRows[0]?.c).toBe('0')

    // The metrics moved.
    const after = await app.inject({ method: 'GET', url: '/metrics' })
    const lines = after.body.split('\n')
    const partitionsLine = lines.find((l) =>
      l.startsWith('lyraflow_retention_partitions_dropped_total '),
    )
    const lastRunLine = lines.find((l) =>
      l.startsWith('lyraflow_retention_last_run_timestamp_seconds '),
    )
    expect(partitionsLine).toBeDefined()
    expect(lastRunLine).toBeDefined()

    const partitionsValue = Number(partitionsLine?.split(' ')[1])
    expect(partitionsValue).toBeGreaterThan(0)

    const lastRunValue = Number(lastRunLine?.split(' ')[1])
    // A live Unix-seconds timestamp bracketing the actual run — not the
    // stale 0 the first test above pinned before any run had happened.
    expect(lastRunValue).toBeGreaterThanOrEqual(Math.floor(beforeRun / 1000) - 5)
    expect(lastRunValue).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5)
  })

  // `retentionPartitionsDropped` in app.ts is a running total across every
  // run for the life of the process (`+=` in `onRun`), not the LATEST run's
  // own count (`=`). The single-run test above cannot tell those two apart:
  // starting from 0, a first run's `+=` and `=` produce the identical
  // number. This test needs three runs to discriminate in both directions:
  // an EMPTY run must not zero the total out (catches `=` resetting it to
  // this run's own zero), and a THIRD run with fresh work must ADD to the
  // running total rather than replace it (catches `=` discarding what
  // earlier runs had already contributed). A `=` mutation at app.ts's onRun
  // fails this test at the empty-run assertion already; the third run's
  // assertion is there so a subtler bug that only shows up on non-empty runs
  // cannot hide behind it.
  it('accumulates lyraflow_retention_partitions_dropped_total across runs — an empty run does not reset it, and a later run adds to it rather than replacing it', async () => {
    await seedOldEvent(15)
    await app.deps.retention.runOnce()
    const afterRun1 = await partitionsDroppedTotal()
    expect(afterRun1).toBeGreaterThan(0)

    // Run 2: nothing left to expire — an EMPTY run. Proves the counter is
    // never overwritten with "this run's own count" (which would be 0 here).
    await app.deps.retention.runOnce()
    const afterEmptyRun = await partitionsDroppedTotal()
    expect(afterEmptyRun).toBe(afterRun1)

    // Run 3: a SECOND expired month, in a partition distinct from run 1's.
    // Measure exactly what THIS run drops via Guard 5's own log line — an
    // independent signal from the metric under test — so the assertion
    // below is "the metric grew by exactly what this run did", not a
    // hardcoded guess at how many tables RETENTION_TABLES has.
    await seedOldEvent(17)
    const infoSpy = vi.spyOn(app.log, 'info')
    await app.deps.retention.runOnce()
    const run3Drops = infoSpy.mock.calls.filter(
      (call): call is [Record<string, unknown>, string] =>
        call[1] === 'retention dropped partition',
    ).length
    infoSpy.mockRestore()
    expect(run3Drops).toBeGreaterThan(0)

    const afterRun3 = await partitionsDroppedTotal()
    // The discriminating assertion: with the correct `+=`, afterRun3 is the
    // OLD total plus this run's own drops. With `=`, afterRun3 would equal
    // only `run3Drops` (typically 2), discarding afterEmptyRun's contribution
    // entirely — a strictly smaller number whenever afterEmptyRun > 0, which
    // run 1 guarantees.
    expect(afterRun3).toBe(afterEmptyRun + run3Drops)
  })

  // Pins the README's *Retention* section claim about the person read and
  // export routes, precisely because a Task 4 review round found the
  // original text asserting the OPPOSITE of this — a "profile with traits
  // and no event lines" that the real routes never produce. Both routes
  // decide existence from an event count (personEventSummary); retention
  // drops every event this person has, so both 404 identically to an id
  // that was never recorded, even though person_traits (never touched by
  // retention — see store.ts's own RETENTION_TABLES) still holds the trait.
  it('leaves a fully-expired person retrievable nowhere in the API, even though their traits physically survive', async () => {
    const userId = `retention-wiring-sar-${Date.now()}`
    await seedFullyExpiredPersonWithTraits(userId, 14)

    const headers = { 'x-lyraflow-server-key': SERVER_KEY }

    // Sanity check: before retention runs, this person is a normal,
    // retrievable profile with real events.
    const before = await app.inject({ method: 'GET', url: `/v1/persons/${userId}`, headers })
    expect(before.statusCode).toBe(200)
    expect(before.json().events).toBeGreaterThan(0)

    await app.deps.retention.runOnce()

    // Both the profile read and the export now 404 — not a 200 with a
    // traits-only body.
    const afterRead = await app.inject({ method: 'GET', url: `/v1/persons/${userId}`, headers })
    expect(afterRead.statusCode).toBe(404)
    expect(afterRead.json()).toEqual({ error: 'person_not_found' })

    const afterExport = await app.inject({
      method: 'GET',
      url: `/v1/persons/${userId}/export`,
      headers,
    })
    expect(afterExport.statusCode).toBe(404)
    expect(afterExport.json()).toEqual({ error: 'person_not_found' })

    // The trait is still there, physically — just unreachable through
    // either route above. Read directly, the way the README describes.
    const rs = await ch.query({
      query: `SELECT trait_key, argMaxMerge(value_str) AS v FROM person_traits
              WHERE project_id = {p:UInt32} AND user_id = {u:String}
              GROUP BY trait_key`,
      query_params: { p: projectId, u: userId },
      format: 'JSONEachRow',
    })
    const traits = await rs.json<{ trait_key: string; v: string }>()
    expect(traits).toEqual([{ trait_key: 'email', v: 'person@example.test' }])
  })
})
