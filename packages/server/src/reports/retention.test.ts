//
// Seeds a real ClickHouse and asserts a GRID, not SQL text. `sumForEach` over
// an indicator array is the kind of construct that parses, runs, and answers
// a slightly different question -- an off-by-one in the period index, a
// person counted in two cohorts, a return that predates the cohort quietly
// landing in column 0. None of those is visible in the query text.
import { join } from 'node:path'
import { Params, type RetentionQuery, compileRetention } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { runRetention } from './execute.js'

const CH_DB = 'lyraflow_test'
const PROJECT = 7702

// Every one of these is a MONDAY, which is what `toStartOfWeek(t, 1)` buckets
// to. Named rather than inlined because every expectation below is read
// against them, and a grid whose rows are off by one week is a report that
// looks entirely plausible.
const W0 = '2026-06-01'
const W1 = '2026-06-08'
const W2 = '2026-06-15'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
})

const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const uuid = (n: number) => `77020000-0000-4000-8000-${String(n).padStart(12, '0')}`

let seq = 0
const ev = (person: string, name: string, day: string) => ({
  project_id: PROJECT,
  event_id: uuid(++seq),
  anonymous_id: `dev-${person}`,
  user_id: person,
  event_name: name,
  timestamp: `${day} 10:00:00.000`,
  received_at: `${day} 10:00:00.000`,
  trusted: 1,
  properties: {},
  properties_num: {},
})

/** Long after every seeded event, so every cell is measurable. */
const SETTLED = new Date('2026-07-15T00:00:00.000Z')

const grid = async (over: Partial<RetentionQuery>, now: Date = SETTLED) => {
  const query: RetentionQuery = {
    start_event: 'signed_up',
    return_event: 'project_created',
    granularity: 'week',
    periods: 3,
    since: '2026-06-01T00:00:00Z',
    until: '2026-06-15T00:00:00Z',
    ...over,
  }
  const compiled = compileRetention({
    query,
    projectId: PROJECT,
    database: CH_DB,
    now,
    params: new Params(),
  })
  return runRetention({ client: ch, compiled, query, now })
}

const row = (r: Awaited<ReturnType<typeof grid>>, cohort: string) =>
  r.cohorts.find((c) => c.cohort === cohort)

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  await pg.query('DELETE FROM projects WHERE id = $1', [PROJECT])
  await pg.query(
    `INSERT INTO projects (id, name, slug, write_key, server_key_hash)
     VALUES ($1, 'Retention', 'retention-test', 'wk_retention', 'h')`,
    [PROJECT],
  )
  // Same self-healing as segments/execute.test.ts: `device_index` is written
  // by a materialized view that an `events` DELETE never reaches, and the
  // base population is built from it.
  for (const table of ['events', 'device_index', 'person_traits']) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = ${PROJECT}`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      // Cohort W0.
      ev('a1', 'signed_up', '2026-06-03'),
      ev('a1', 'project_created', '2026-06-04'), // period 0
      ev('a1', 'project_created', '2026-06-09'), // period 1
      ev('a1', 'project_created', '2026-06-16'), // period 2
      // Period 3, so the LAST column of W0's row is non-zero. With a zero
      // there, an indicator array one cell short is arithmetically invisible
      // -- which is exactly how that mutation survived the first pass.
      ev('a1', 'project_created', '2026-06-23'),
      ev('a2', 'signed_up', '2026-06-05'),
      ev('a2', 'project_created', '2026-06-10'), // period 1
      // ...and signs up AGAIN in W1. Their cohort must stay W0: a person
      // belongs to the period of their FIRST start event in the range, and a
      // second one must not move them or duplicate them.
      ev('a2', 'signed_up', '2026-06-11'),
      ev('a3', 'signed_up', '2026-06-06'), // never returns

      // Cohort W1.
      ev('b1', 'signed_up', '2026-06-09'),
      ev('b1', 'project_created', '2026-06-17'), // period 1
      // c1 returns BEFORE they enter. Their cohort is W1, and the W0 event
      // sits at period -1 -- it must not be counted anywhere, least of all in
      // column 0, which is where an unsigned index would put it.
      ev('c1', 'project_created', '2026-06-02'),
      ev('c1', 'signed_up', '2026-06-09'),
    ],
  })
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE id = $1', [PROJECT])
  await pg.end()
  await ch.close()
})

describe('retention grid (live ClickHouse)', () => {
  it('buckets people into the week of their first start event', async () => {
    const r = await grid({})
    expect(r.cohorts.map((c) => c.cohort)).toEqual([W0, W1])
    expect(row(r, W0)?.size).toBe(3)
    expect(row(r, W1)?.size).toBe(2)
  })

  it('counts a return in the period it happened, and nowhere else', async () => {
    const r = await grid({})
    // a1 in 0, 1, 2; a2 in 1; a3 never.
    expect(row(r, W0)?.retained).toEqual([1, 2, 1, 1])
  })

  it('does not re-cohort or duplicate a person who starts a second time', async () => {
    const r = await grid({})
    // a2 signed up again in W1. W1 holds b1 and c1 only.
    expect(row(r, W1)?.size).toBe(2)
    const total = r.cohorts.reduce((n, c) => n + c.size, 0)
    expect(total).toBe(5)
  })

  it('ignores a return that predates the cohort rather than counting it at period 0', async () => {
    const r = await grid({})
    // c1's only project_created is in W0, a week BEFORE their W1 cohort.
    // b1 returns in period 1. So period 0 is nobody.
    expect(row(r, W1)?.retained).toEqual([0, 1, 0, 0])
  })

  it('marks a period that has not finished as null, never as zero', async () => {
    // 2026-06-20 is inside W2, so W2 is unfinished: W0's period 2 (which ends
    // 2026-06-22) and everything after it cannot have been measured.
    const r = await grid({}, new Date('2026-06-20T00:00:00.000Z'))
    expect(row(r, W0)?.retained).toEqual([1, 2, null, null])
    expect(row(r, W1)?.retained).toEqual([0, null, null, null])
  })

  it('fills those cells in once the periods have closed', async () => {
    // The same request, later. This is the assertion that would fail if
    // measurability were baked into the SQL rather than applied to the result.
    const r = await grid({})
    expect(row(r, W0)?.retained[2]).toBe(1)
  })

  it('reads * as any event on the start side', async () => {
    const r = await grid({ start_event: '*' })
    // c1's FIRST event is a project_created on 2026-06-02, which is W0 --
    // so `*` moves them out of W1, where `signed_up` put them.
    expect(row(r, W0)?.size).toBe(4)
    expect(row(r, W1)?.size).toBe(1)
  })

  it('reads * as any activity on the return side', async () => {
    const r = await grid({ return_event: '*' })
    // Everyone is active in their own cohort week, because the start event
    // itself is activity.
    expect(row(r, W0)?.retained[0]).toBe(3)
    expect(row(r, W1)?.retained[0]).toBe(2)
  })

  it('gives period 0 as the whole cohort when start and return are the same event', async () => {
    const r = await grid({ start_event: 'signed_up', return_event: 'signed_up' })
    expect(row(r, W0)?.retained[0]).toBe(row(r, W0)?.size)
    // a2 signed up again in W1, which is period 1 of their own cohort.
    expect(row(r, W0)?.retained[1]).toBe(1)
  })

  it('returns a row of exactly periods + 1 cells', async () => {
    const r = await grid({ periods: 6 })
    for (const c of r.cohorts) expect(c.retained).toHaveLength(7)
  })

  it('refuses a row whose cell count disagrees with `periods`, rather than padding it', async () => {
    // Not reachable through the API -- `compileRetention` and `runRetention`
    // derive the length from the same `periods`. It is asserted because the
    // ALTERNATIVE was reachable: a `?? 0` fallback rendered a short array as
    // a column of zeroes, and zero is a real answer here.
    const query: RetentionQuery = {
      start_event: 'signed_up',
      return_event: 'project_created',
      granularity: 'week',
      periods: 3,
      since: '2026-06-01T00:00:00Z',
      until: '2026-06-15T00:00:00Z',
    }
    const compiled = compileRetention({
      query,
      projectId: PROJECT,
      database: CH_DB,
      now: SETTLED,
      params: new Params(),
    })
    await expect(
      runRetention({ client: ch, compiled, query: { ...query, periods: 5 }, now: SETTLED }),
    ).rejects.toThrow(/has 4 cells, expected 6/)
  })

  it('excludes anyone whose first start event falls outside the range', async () => {
    // until = W1, so W1 entrants are excluded entirely.
    const r = await grid({ until: '2026-06-08T00:00:00Z' })
    expect(r.cohorts.map((c) => c.cohort)).toEqual([W0])
  })

  it('measures past `until`, because the range bounds entry rather than observation', async () => {
    // W0's period 2 is the week of 2026-06-15, a week past `until`. A scan
    // stopping at `until` would report it as zero.
    const r = await grid({ until: '2026-06-08T00:00:00Z' })
    expect(row(r, W0)?.retained).toEqual([1, 2, 1, 1])
  })
})
