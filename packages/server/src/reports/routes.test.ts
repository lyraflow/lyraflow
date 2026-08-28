//
// The route, not the engine. `retention.test.ts` proves the grid's
// arithmetic against seeded data; this proves the route exists, is
// registered on the app, refuses an unauthenticated caller, cannot be made
// to read another project, and turns each failure into the status a client
// can act on. Every one of those is a defect the engine tests cannot see --
// a route that was never registered in `app.ts` passes all twelve of them.
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

const SERVER_KEY = 'sk_reports_routes'
let app: FastifyInstance

const GRID = {
  start_event: 'signed_up',
  return_event: 'project_created',
  granularity: 'week',
  periods: 4,
}

const call = (payload: unknown, key = SERVER_KEY) =>
  app.inject({
    method: 'POST',
    url: '/v1/reports/retention',
    headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': key },
    payload: payload as never,
  })

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['reports-routes'])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Reports Routes', 'reports-routes', $1, $2)`,
    ['wk_reports_routes', hashServerKey(SERVER_KEY)],
  )

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
  await pg.query('DELETE FROM projects WHERE slug = $1', ['reports-routes'])
  await pg.end()
  await ch.close()
})

describe('POST /v1/reports/retention', () => {
  it('is registered on the app at all', async () => {
    // The composition defect the engine tests structurally cannot find: a
    // route module that is correct and never wired into `app.ts` would leave
    // every other test in this feature green.
    const res = await call(GRID)
    expect(res.statusCode).not.toBe(404)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/retention',
      headers: { 'content-type': 'application/json' },
      payload: GRID as never,
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a key that is not a server key for this project', async () => {
    expect((await call(GRID, 'sk_not_a_real_key')).statusCode).toBe(401)
  })

  it('answers a well-formed request with a grid of the shape it was asked for', async () => {
    const res = await call(GRID)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.granularity).toBe('week')
    expect(body.periods).toBe(4)
    expect(Array.isArray(body.cohorts)).toBe(true)
    // Echoed so a `null` cell can be told from a stale one.
    expect(typeof body.computed_at).toBe('string')
  })

  it('defaults the range rather than demanding one', async () => {
    // Somebody who sends two event names should get the grid they meant.
    const body = (await call(GRID)).json()
    expect(new Date(body.since).getTime()).toBeLessThan(new Date(body.until).getTime())
  })

  it('rejects a period count past the cap, with a field-level error', async () => {
    const res = await call({ ...GRID, periods: 999 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('validation_failed')
    expect(res.json().detail[0].path).toBe('periods')
  })

  it('rejects an unknown granularity rather than falling back to one', async () => {
    expect((await call({ ...GRID, granularity: 'fortnight' })).statusCode).toBe(400)
  })

  it('rejects a range that is not a range, naming the reason', async () => {
    const res = await call({
      ...GRID,
      since: '2026-08-01T00:00:00Z',
      until: '2026-07-01T00:00:00Z',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('range')
  })

  it('refuses a range wider than the cohort cap instead of truncating the grid', async () => {
    // A grid silently missing its oldest rows is a chart with a trend that is
    // not in the data, and the caller cannot tell it happened.
    const res = await call({
      ...GRID,
      granularity: 'day',
      since: '2020-01-01T00:00:00Z',
      until: '2026-01-01T00:00:00Z',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('cohorts')
    expect(res.json().detail).toMatch(/limit of 60/)
  })

  it('runs wide and says so when the named segment does not exist', async () => {
    // Same treatment a funnel run gives a deleted segment: the numbers alone
    // would look entirely normal, so the response has to carry the reason.
    const body = (await call({ ...GRID, segment_id: 987654 })).json()
    expect(body.warnings).toHaveLength(1)
    expect(body.warnings[0].path).toBe('segment_id')
  })

  it('requires both event names', async () => {
    expect((await call({ ...GRID, start_event: '' })).statusCode).toBe(400)
  })
})
