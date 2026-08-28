//
// The trends breakdown, against a real ClickHouse. `breakdown.test.ts` pins
// the parsing and the fold as pure functions; this pins what the generated
// SQL MEANS -- that a numeric property is not silently one empty series, that
// events lacking the property stay visible, that a weekly bucket starts on
// the Monday the retention grid also starts on.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const PROJECT = 7703
const SERVER_KEY = 'sk_trends_routes'
let app: FastifyInstance

let seq = 0
const ev = (
  name: string,
  day: string,
  properties: Record<string, string> = {},
  properties_num: Record<string, number> = {},
  columns: Record<string, string> = {},
) => ({
  project_id: PROJECT,
  event_id: `77030000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  anonymous_id: `dev-${seq}`,
  user_id: '',
  event_name: name,
  timestamp: `${day} 10:00:00.000`,
  received_at: `${day} 10:00:00.000`,
  trusted: 1,
  properties,
  properties_num,
  ...columns,
})

const RANGE = 'since=2026-06-01T00:00:00Z&until=2026-06-16T00:00:00Z'

const stats = async (query: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/events/stats?${RANGE}&${query}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY },
  })
  return { status: res.statusCode, body: res.json() }
}

/** Total events per series across the whole window. */
const totals = (body: { buckets: { series?: string; events: number }[] }) => {
  const out: Record<string, number> = {}
  for (const b of body.buckets) out[b.series ?? ''] = (out[b.series ?? ''] ?? 0) + b.events
  return out
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['trends-routes'])
  await pg.query(
    `INSERT INTO projects (id, name, slug, write_key, server_key_hash)
     VALUES ($1, 'Trends', 'trends-routes', $2, $3)`,
    [PROJECT, 'wk_trends_routes', hashServerKey(SERVER_KEY)],
  )
  for (const table of ['events', 'device_index', 'person_traits']) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = ${PROJECT}`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }

  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      // Week of 2026-06-01 (a Monday).
      ev('checkout', '2026-06-03', { plan: 'pro' }),
      ev('checkout', '2026-06-03', { plan: 'pro' }),
      ev('checkout', '2026-06-04', { plan: 'pro' }),
      ev('checkout', '2026-06-04', { plan: 'free' }),
      ev('checkout', '2026-06-05', { plan: 'free' }),
      // No `plan` at all -- must stay VISIBLE as `(not set)`, not vanish.
      ev('checkout', '2026-06-05'),
      // `seats` is a NUMBER, so it lands in properties_num and nowhere else.
      // A breakdown reading only the string bag reports it as one empty
      // series, which is the defect this row exists to catch.
      ev('checkout', '2026-06-05', {}, { seats: 5 }),
      ev('signup', '2026-06-03', {}, {}, { utm_source: 'newsletter' }),
      ev('signup', '2026-06-03', {}, {}, { utm_source: 'newsletter' }),
      ev('signup', '2026-06-04', {}, {}, { utm_source: 'twitter' }),
      // No utm_source: the column exists and is empty, which is a different
      // thing from an absent map key and must still read as `(not set)`.
      ev('signup', '2026-06-04'),
      // Week of 2026-06-08.
      ev('checkout', '2026-06-10', { plan: 'pro' }),
      // Twelve distinct names, two past the ten-series fold, each one rarer
      // than `checkout` -- so any fold applied to `group_by=event_name` would
      // sweep the last two into `(other)`.
      ...Array.from({ length: 12 }, (_, i) => ev(`rare_${i}`, '2026-06-11')),
    ],
  })

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    LYRAFLOW_FLUSH_ROWS: '1',
  } as NodeJS.ProcessEnv)
  const readiness = new Readiness()
  readiness.markReady()
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', ['trends-routes'])
  await pg.end()
  await ch.close()
})

describe('GET /v1/events/stats with a breakdown (live ClickHouse)', () => {
  it('splits by a string property', async () => {
    const { status, body } = await stats('event=checkout&interval=1d&group_by=property:plan')
    expect(status).toBe(200)
    expect(totals(body)).toEqual({ pro: 4, free: 2, '(not set)': 2 })
  })

  it('keeps events without the property visible, so the series sum to the total', async () => {
    // The reconciliation rule: a breakdown whose parts do not add up to the
    // unbroken count is one nobody can check against the Feed.
    const broken = await stats('event=checkout&interval=1d&group_by=property:plan')
    const whole = await stats('event=checkout&interval=1d')
    const brokenTotal = Object.values(totals(broken.body)).reduce((a, b) => a + b, 0)
    const wholeTotal = whole.body.buckets.reduce(
      (n: number, b: { events: number }) => n + b.events,
      0,
    )
    expect(brokenTotal).toBe(wholeTotal)
  })

  it('reads a NUMERIC property, which lives only in the other bag', async () => {
    const { body } = await stats('event=checkout&interval=1d&group_by=property:seats')
    // One event carries seats=5; the other seven carry no `seats` at all.
    expect(totals(body)).toEqual({ '5': 1, '(not set)': 7 })
  })

  it('splits by an event column, and labels an empty one', async () => {
    const { body } = await stats('event=signup&interval=1d&group_by=attribute:utm_source')
    expect(totals(body)).toEqual({ newsletter: 2, twitter: 1, '(not set)': 1 })
  })

  it('still answers the pre-trends group_by=event_name, with the field it always had', async () => {
    // The CLI's snippet command reads `event_name`. Adding `series` must not
    // take it away.
    const { body } = await stats('interval=1d&group_by=event_name')
    const names = body.buckets.map((b: { event_name?: string }) => b.event_name)
    expect(names).toContain('checkout')
    expect(names).toContain('signup')
    expect(body.buckets.every((b: { series?: string }) => typeof b.series === 'string')).toBe(true)
  })

  it('omits the series field entirely when nothing is grouped', async () => {
    const { body } = await stats('interval=1d')
    expect(body.buckets.every((b: object) => !('series' in b))).toBe(true)
  })

  it('buckets a weekly interval to Monday, the same day the retention grid uses', async () => {
    const { body } = await stats('event=checkout&interval=1w&group_by=property:plan')
    const buckets = [...new Set(body.buckets.map((b: { bucket: string }) => b.bucket))].sort()
    expect(buckets).toEqual(['2026-06-01T00:00:00.000Z', '2026-06-08T00:00:00.000Z'])
  })

  it('reports zero folded series when everything fits', async () => {
    const { body } = await stats('event=checkout&interval=1d&group_by=property:plan')
    expect(body.folded_series).toBe(0)
  })

  it('never folds group_by=event_name, however many names there are', async () => {
    // A CONTRACT, not a preference. That form predates trends and its callers
    // -- the CLI's snippet command among them -- read it as the list of event
    // names this project has recorded, so folding the rarest into `(other)`
    // would silently shorten that list. It also needs no cap: event-name
    // cardinality is bounded at ingest, unlike a property key.
    //
    // This regressed once. The fold was applied to every breakdown, and an
    // unrelated probe event disappeared from a `group_by=event_name` response
    // -- caught by a test in `routes.test.ts` that was not written for it.
    const { body } = await stats('interval=1d&group_by=event_name')
    const names = new Set(body.buckets.map((b: { event_name?: string }) => b.event_name))
    for (let i = 0; i < 12; i++) expect(names.has(`rare_${i}`)).toBe(true)
    expect(names.has('(other)')).toBe(false)
    expect(body.folded_series).toBe(0)
  })

  it('refuses an unknown group_by rather than silently ignoring it', async () => {
    // Ignoring it would return an ungrouped chart that looks like a grouped
    // one with a single series.
    const bad = await stats('interval=1d&group_by=trait:plan')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_group_by')
  })

  it('refuses a column that is not on the allowlist', async () => {
    const bad = await stats('interval=1d&group_by=attribute:event_id')
    expect(bad.status).toBe(400)
  })

  it('narrows to one event and splits it at the same time', async () => {
    const { body } = await stats('event=checkout&interval=1w&group_by=property:plan')
    expect(totals(body).pro).toBe(4)
    expect(totals(body).free).toBe(2)
  })
})
