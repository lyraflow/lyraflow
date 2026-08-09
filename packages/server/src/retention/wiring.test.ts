// This file proves what app.ts's own wiring adds on top of RetentionStore
// and RetentionWorker (both already covered exhaustively by store.test.ts
// and worker.test.ts): that a real drop, driven through the real app, (1)
// logs one `info` line per partition actually dropped, naming project,
// table and partition (Guard 5 — see app.ts), and (2) moves the two
// `/metrics` series app.ts wires from `onRun`. It drives the worker through
// `runOnce()` directly, never its own timer — see app.ts's own comment on
// why `buildApp` never starts it, and privacy/end-to-end.test.ts for the
// identical discipline applied to PurgeWorker.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
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

async function seedOldEvent(): Promise<void> {
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
        timestamp: chAt(monthsAgo(14)),
        received_at: chAt(monthsAgo(14)),
        trusted: 1,
        properties: {},
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
     VALUES ('Retention Wiring', $1, 'wk_ret_wiring', 'h', 13) RETURNING id`,
    [SLUG],
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
})
