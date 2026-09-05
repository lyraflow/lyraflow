import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { ensureAdminUser } from '../auth/bootstrap.js'
import { hashServerKey } from '../auth/project-cache.js'
import { AttemptLimiter } from '../auth/rate-limit.js'
import { loadConfig } from '../config.js'
import { DashboardStore } from '../dashboards/store.js'
import { FUNNEL_DEFAULT_RANGE_MS } from '../funnels/run.js'
import { Readiness } from '../health.js'
import { InFlightCap, ResultCache } from './limits.js'

// `runStats` and `runRetentionReport` are ESM namespace exports, and a
// namespace binding is not configurable -- `vi.spyOn(module, 'runStats')`
// throws rather than intercepting the call `routes.ts` makes. Wrapping the
// whole module is the seam that works, the same shape sdk/routes.test.ts
// uses for `node:fs`; `vi.mock` is hoisted above the imports below, so
// `shared/routes.ts` and `events/routes.ts` both bind the wrapper rather
// than the original. Both paths going through one spy is what makes the
// derivation tests below able to compare a shared run against the
// operator's own route call by call.
vi.mock('../events/stats.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../events/stats.js')>()
  return { ...orig, runStats: vi.fn(orig.runStats) }
})
vi.mock('../reports/retention-run.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../reports/retention-run.js')>()
  return { ...orig, runRetentionReport: vi.fn(orig.runRetentionReport) }
})
import { runStats } from '../events/stats.js'
import { runRetentionReport } from '../reports/retention-run.js'

const statsSpy = vi.mocked(runStats)
const retentionSpy = vi.mocked(runRetentionReport)

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const WRITE_KEY = 'wk_shared_routes'
const SERVER_KEY = 'sk_shared_routes'
const OTHER_SERVER_KEY = 'sk_shared_routes_other'

const EMAIL = 'shared-routes-suite@example.test'
const PASSWORD = 'shared-routes-suite-password'

let app: FastifyInstance
let projectId: number
let otherProjectId: number
let config: ReturnType<typeof loadConfig>
let readiness: Readiness

const call = (
  method: 'POST' | 'GET' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  key = SERVER_KEY,
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'x-lyraflow-server-key': key,
    },
    payload: payload as never,
  })

/** The cookie value only, from a Set-Cookie header -- same helper as auth/wiring.test.ts. */
function cookieValue(setCookie: string): string {
  return (setCookie.split(';')[0] ?? '').split('=')[1] ?? ''
}

/** A real login, not a hand-minted session -- the "ignores a valid session
 *  cookie" test below is only worth anything if the cookie it presents is
 *  one the authenticated surface would actually accept. */
async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-lyraflow-ui': '1' },
    payload: { email: EMAIL, password: PASSWORD },
  })
  expect(res.statusCode).toBe(200)
  const setCookie = res.headers['set-cookie']
  return cookieValue(Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? ''))
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['shared-routes', 'shared-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Shared Routes', 'shared-routes', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Shared Routes Other', 'shared-routes-other', $1, $2) RETURNING id`,
    ['wk_shared_routes_other', hashServerKey(OTHER_SERVER_KEY)],
  )
  otherProjectId = Number(other.rows[0]?.id)

  // Single-tenant, same as auth/wiring.test.ts -- cleared in both
  // beforeAll and afterAll rather than assumed empty.
  await pg.query('DELETE FROM admin_user')
  await ensureAdminUser(pg, { email: EMAIL, password: PASSWORD })

  config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    LYRAFLOW_FLUSH_ROWS: '1',
  } as NodeJS.ProcessEnv)

  readiness = new Readiness()
  readiness.markReady()
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

beforeEach(async () => {
  // `mockRestore`, not `mockClear`: the in-flight test below installs a
  // never-resolving implementation, and if that test ever fails by TIMING
  // OUT its own `finally` does not run -- the suspended async body is
  // abandoned where it awaits. Restoring here rather than only there means
  // one test's stub can never leak into the next and fail it for a reason
  // that has nothing to do with it. For a `vi.fn(impl)`, `mockRestore`
  // puts `impl` back.
  statsSpy.mockRestore()
  retentionSpy.mockRestore()
  await pg.query('DELETE FROM dashboards WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
  await pg.query('DELETE FROM trend_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
  await pg.query('DELETE FROM retention_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
  await pg.query('DELETE FROM funnels WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['shared-routes', 'shared-routes-other'],
  ])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

async function makeTrend(): Promise<number> {
  const res = await call('POST', '/v1/trends', {
    name: `t-${Math.random()}`,
    event: 'signup',
    interval: '1d',
  })
  expect(res.statusCode).toBe(201)
  return res.json().id
}

async function makeRetention(): Promise<number> {
  const res = await call('POST', '/v1/retention-reports', {
    name: `r-${Math.random()}`,
    start_event: 'signup',
    return_event: 'login',
    granularity: 'day',
    periods: 3,
  })
  expect(res.statusCode).toBe(201)
  return res.json().id
}

async function makeFunnel(): Promise<number> {
  const res = await call('POST', '/v1/funnels', {
    name: `f-${Math.random()}`,
    steps: [{ event: 'a' }, { event: 'b' }],
    window_seconds: 3600,
  })
  expect(res.statusCode).toBe(201)
  return res.json().id
}

async function sharedDashboard(tiles: unknown[]): Promise<{ id: number; token: string }> {
  const d = await call('POST', '/v1/dashboards', { name: `d-${Math.random()}`, tiles })
  expect(d.statusCode).toBe(201)
  const s = await call('POST', `/v1/dashboards/${d.json().id}/share`)
  expect(s.statusCode).toBe(200)
  return { id: d.json().id, token: s.json().token }
}

const view = (token: string) => app.inject({ method: 'GET', url: `/v1/shared/${token}` })
const run = (token: string, index: number, range = '7d') =>
  app.inject({
    method: 'POST',
    url: `/v1/shared/${token}/tiles/${index}/run`,
    headers: { 'content-type': 'application/json' },
    payload: { range },
  })

describe('GET /v1/shared/:token', () => {
  it('resolves the dashboard with its tiles and nothing that names the project', async () => {
    const t = await makeTrend()
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    const res = await view(token)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      name: expect.any(String),
      updated_at: expect.any(String),
      stale: false,
      tiles: [
        expect.objectContaining({
          kind: 'trend',
          report_id: t,
          report: expect.objectContaining({ event: 'signup' }),
        }),
      ],
    })
    // The body carries exactly four keys, and none of the operator-only
    // ones: a token holder gets the layout and the definitions it names,
    // never the dashboard's own id, its home flag, or anything that
    // identifies the project it belongs to. Asserted on the key SET rather
    // than on the absence of `"id":`, which every embedded report
    // legitimately carries.
    expect(Object.keys(res.json()).sort()).toEqual(['name', 'stale', 'tiles', 'updated_at'])
    const text = res.body
    expect(text).not.toContain('is_home')
    expect(text).not.toContain('Shared Routes')
    expect(text).not.toContain('"project_id"')
  })

  it('404 share_not_found for unknown, malformed, revoked and deleted, with one body', async () => {
    const byShareToken = vi.spyOn(DashboardStore.prototype, 'byShareToken')
    try {
      const { id, token } = await sharedDashboard([])
      byShareToken.mockClear()
      const bodies = new Set<string>()
      bodies.add((await view('A'.repeat(43))).body)
      bodies.add((await view('not-a-token')).body)
      bodies.add((await view('A'.repeat(44))).body)
      // The two malformed ones never reached Postgres; only the unknown
      // but well-formed token did. That is the whole point of the pattern
      // check in `lookup` -- a path segment that cannot be a token is not
      // worth a query, and this is what pins the guard, since a query with
      // a malformed token would 404 from Postgres anyway.
      expect(byShareToken).toHaveBeenCalledTimes(1)
      expect(byShareToken).toHaveBeenCalledWith('A'.repeat(43))

      await call('DELETE', `/v1/dashboards/${id}/share`)
      bodies.add((await view(token)).body)
      const second = await sharedDashboard([])
      await call('DELETE', `/v1/dashboards/${second.id}`)
      bodies.add((await view(second.token)).body)
      expect(bodies).toEqual(new Set([JSON.stringify({ error: 'share_not_found' })]))
      for (const t of ['A'.repeat(43), 'not-a-token', 'A'.repeat(44), token, second.token]) {
        expect((await view(t)).statusCode).toBe(404)
      }
    } finally {
      byShareToken.mockRestore()
    }
  })

  it('ignores a valid session cookie and a valid server key', async () => {
    const wrong = 'B'.repeat(43)
    const withKey = await app.inject({
      method: 'GET',
      url: `/v1/shared/${wrong}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(withKey.statusCode).toBe(404)
    const cookie = await login()
    const withSession = await app.inject({
      method: 'GET',
      url: `/v1/shared/${wrong}`,
      headers: {
        cookie: `lf_session=${cookie}`,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(withSession.statusCode).toBe(404)
  })

  it('a share token opens nothing under the authenticated surface', async () => {
    const { token } = await sharedDashboard([])
    for (const url of [
      '/v1/dashboards',
      '/v1/trends',
      '/v1/retention-reports',
      '/v1/funnels',
      '/v1/events/stats',
      '/v1/project',
    ]) {
      const asKey = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-lyraflow-server-key': token },
      })
      expect(asKey.statusCode).toBe(401)
      const asCookie = await app.inject({
        method: 'GET',
        url,
        headers: {
          cookie: `lf_session=${token}`,
          'x-lyraflow-ui': '1',
          'x-lyraflow-project': String(projectId),
        },
      })
      expect(asCookie.statusCode).toBe(401)
    }
  })

  it('a stale dashboard reads back stale with no tiles', async () => {
    const { id, token } = await sharedDashboard([])
    // An array (the CHECK allows it) that `TileList` cannot parse: stale.
    await pg.query(`UPDATE dashboards SET tiles = '[{"kind":"nope"}]'::jsonb WHERE id = $1`, [id])
    const res = await view(token)
    expect(res.json()).toMatchObject({ stale: true, tiles: [] })
    expect((await run(token, 0)).statusCode).toBe(404)
  })
})

describe('POST /v1/shared/:token/tiles/:index/run', () => {
  it("runs each kind and answers in that kind's own shape", async () => {
    const t = await makeTrend()
    const r = await makeRetention()
    const f = await makeFunnel()
    const { token } = await sharedDashboard([
      { kind: 'trend', report_id: t, width: 'half' },
      { kind: 'retention', report_id: r, width: 'half' },
      { kind: 'funnel', report_id: f, width: 'full' },
    ])
    const a = await run(token, 0)
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual({ kind: 'trend', result: { buckets: [] } })
    const b = await run(token, 1)
    expect(b.statusCode).toBe(200)
    expect(b.json()).toMatchObject({
      kind: 'retention',
      result: { granularity: 'day', periods: 3, cohorts: expect.any(Array) },
    })
    const c = await run(token, 2)
    expect(c.statusCode).toBe(200)
    expect(c.json()).toMatchObject({
      kind: 'funnel',
      result: { entered: 0, steps: expect.any(Array) },
    })
  })

  it("derives exactly the query the operator's route derives, for a trend", async () => {
    const where = [{ property: 'country', operator: '=', value: 'TR' }]
    const t = await call('POST', '/v1/trends', {
      name: `t-${Math.random()}`,
      event: 'signup',
      interval: '1d',
      // `property:plan`, not `attribute:plan` (which the brief named):
      // `parseBreakdown` checks an `attribute:` name against
      // EVENT_COLUMN_FIELDS, and `plan` is not a column on `events`.
      group_by: 'property:plan',
      where,
    })
    expect(t.statusCode).toBe(201)
    const { token } = await sharedDashboard([
      { kind: 'trend', report_id: t.json().id, width: 'half' },
    ])
    expect((await run(token, 0, '7d')).statusCode).toBe(200)

    const now = Date.now()
    const query = new URLSearchParams({
      interval: '1d',
      event: 'signup',
      group_by: 'property:plan',
      where: JSON.stringify(where),
      since: new Date(now - 7 * 86_400_000).toISOString(),
      until: new Date(now).toISOString(),
    })
    const operator = await call('GET', `/v1/events/stats?${query}`)
    expect(operator.statusCode).toBe(200)

    expect(statsSpy).toHaveBeenCalledTimes(2)
    const [sharedCall, operatorCall] = statsSpy.mock.calls.map((c) => c[2])
    expect(sharedCall?.interval).toBe(operatorCall?.interval)
    expect(sharedCall?.event).toBe(operatorCall?.event)
    expect(sharedCall?.breakdown).toEqual(operatorCall?.breakdown)
    expect(sharedCall?.predicates).toEqual(operatorCall?.predicates)
    expect(
      Math.abs((sharedCall?.since?.getTime() ?? 0) - (operatorCall?.since?.getTime() ?? 0)),
    ).toBeLessThan(5000)
    expect(
      Math.abs((sharedCall?.until?.getTime() ?? 0) - (operatorCall?.until?.getTime() ?? 0)),
    ).toBeLessThan(5000)
  })

  it("derives exactly the body the operator's route derives, for a retention report", async () => {
    const created = await call('POST', '/v1/retention-reports', {
      name: `r-${Math.random()}`,
      start_event: 'signup',
      return_event: 'login',
      start_where: [{ property: 'country', operator: '=', value: 'TR' }],
      return_where: [],
      granularity: 'day',
      periods: 4,
    })
    expect(created.statusCode).toBe(201)
    const { token } = await sharedDashboard([
      { kind: 'retention', report_id: created.json().id, width: 'half' },
    ])
    expect((await run(token, 0, '7d')).statusCode).toBe(200)

    const now = Date.now()
    const operator = await call('POST', '/v1/reports/retention', {
      start_event: 'signup',
      return_event: 'login',
      start_where: [{ property: 'country', operator: '=', value: 'TR' }],
      return_where: [],
      granularity: 'day',
      periods: 4,
      segment_id: null,
      since: new Date(now - 7 * 86_400_000).toISOString(),
      until: new Date(now).toISOString(),
    })
    expect(operator.statusCode).toBe(200)

    expect(retentionSpy).toHaveBeenCalledTimes(2)
    const [sharedCall, operatorCall] = retentionSpy.mock.calls.map((c) => c[2])
    expect({ ...sharedCall, since: undefined, until: undefined }).toEqual({
      ...operatorCall,
      since: undefined,
      until: undefined,
    })
    expect(
      Math.abs(Date.parse(sharedCall?.since ?? '') - Date.parse(operatorCall?.since ?? '')),
    ).toBeLessThan(5000)
    expect(
      Math.abs(Date.parse(sharedCall?.until ?? '') - Date.parse(operatorCall?.until ?? '')),
    ).toBeLessThan(5000)
  })

  it('derives the funnel range from the preset, and from the funnel default for auto', async () => {
    // `makeFunnelRunner` is a factory, so its `execute` is not reachable
    // through a module mock the way `runStats` is. The range the run
    // actually used is echoed in the response body, and asserting on that
    // pins the same derivation from the outside.
    const f = await makeFunnel()
    const { token } = await sharedDashboard([{ kind: 'funnel', report_id: f, width: 'full' }])

    const seven = await run(token, 0, '7d')
    expect(seven.statusCode).toBe(200)
    const sevenRange = seven.json().result.range
    expect(Date.parse(sevenRange.until) - Date.parse(sevenRange.since)).toBe(7 * 86_400_000)
    expect(Math.abs(Date.parse(sevenRange.until) - Date.now())).toBeLessThan(5000)

    const auto = await run(token, 0, 'auto')
    expect(auto.statusCode).toBe(200)
    const autoRange = auto.json().result.range
    expect(Date.parse(autoRange.until) - Date.parse(autoRange.since)).toBe(FUNNEL_DEFAULT_RANGE_MS)
    expect(Math.abs(Date.parse(autoRange.until) - Date.now())).toBeLessThan(5000)
  })

  it('auto sends no bounds to a trend (the stats default applies)', async () => {
    const t = await makeTrend()
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    expect((await run(token, 0, 'auto')).statusCode).toBe(200)
    expect(statsSpy.mock.calls[0]?.[2]).toMatchObject({ since: undefined, until: undefined })
  })

  it("refuses a preset over the tile's ceiling with the report endpoint's own code", async () => {
    const t = (
      await call('POST', '/v1/trends', { name: `m-${Math.random()}`, event: 'x', interval: '1m' })
    ).json().id
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    const res = await run(token, 0, '30d')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('window_too_large')
  })

  it('refuses a stale trend before parsing anything of its definition', async () => {
    const t = await makeTrend()
    // `TrendStore` computes `stale` from `event_where` failing
    // `z.array(WherePredicate)`. An ARRAY, because the column's own
    // `trend_reports_where_is_array` CHECK refuses anything else -- one
    // whose single element is not a predicate, which is exactly the row a
    // grammar change leaves behind.
    await pg.query(`UPDATE trend_reports SET event_where = '[{"bad":1}]'::jsonb WHERE id = $1`, [t])
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    const res = await run(token, 0, '7d')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'stale_definition' })
    expect(statsSpy).not.toHaveBeenCalled()
  })

  it('refuses a stale retention report before parsing anything of its definition', async () => {
    const r = await makeRetention()
    // An array whose element is not a predicate, for the reason the trend
    // case above gives: `retention_reports_where_are_arrays` refuses a
    // non-array outright.
    await pg.query(
      `UPDATE retention_reports SET start_where = '[{"bad":1}]'::jsonb WHERE id = $1`,
      [r],
    )
    const { token } = await sharedDashboard([{ kind: 'retention', report_id: r, width: 'half' }])
    const res = await run(token, 0, '7d')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'stale_definition' })
    expect(retentionSpy).not.toHaveBeenCalled()
  })

  it('404s for a bad index, a deleted report, and refuses a bad range with 400', async () => {
    const t = await makeTrend()
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    for (const i of ['1', '-1', '0.5', 'x']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/shared/${token}/tiles/${i}/run`,
        headers: { 'content-type': 'application/json' },
        payload: { range: '7d' },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'tile_not_found' })
    }
    expect((await run(token, 0, 'custom')).statusCode).toBe(400)
    expect((await run(token, 0, 'custom')).json()).toEqual({ error: 'invalid_range' })
    await call('DELETE', `/v1/trends/${t}`)
    const gone = await run(token, 0)
    expect(gone.statusCode).toBe(404)
    expect(gone.json()).toEqual({ error: 'report_not_found' })
  })

  it('a funnel run through the link never records a run', async () => {
    const f = await makeFunnel()
    const { token } = await sharedDashboard([{ kind: 'funnel', report_id: f, width: 'full' }])
    expect((await run(token, 0)).statusCode).toBe(200)
    const detail = await call('GET', `/v1/funnels/${f}`)
    expect(detail.json().last_evaluated_at).toBeNull()
  })

  it('serves the second identical run from the cache', async () => {
    const t = await makeTrend()
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    expect((await run(token, 0, '7d')).statusCode).toBe(200)
    expect((await run(token, 0, '7d')).statusCode).toBe(200)
    expect(statsSpy).toHaveBeenCalledTimes(1)
    expect((await run(token, 0, '30d')).statusCode).toBe(200)
    expect(statsSpy).toHaveBeenCalledTimes(2)
  })

  it('a revoked token gets 404 even with a warm cache', async () => {
    const t = await makeTrend()
    const { id, token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    expect((await run(token, 0)).statusCode).toBe(200)
    await call('DELETE', `/v1/dashboards/${id}/share`)
    expect((await run(token, 0)).statusCode).toBe(404)
  })
})

describe('limits', () => {
  it('429 with retry-after past the per-token window, other tokens unaffected', async () => {
    const small = buildApp({
      config,
      pg,
      ch,
      readiness,
      shared: { limiter: new AttemptLimiter(2, 60_000), cache: new ResultCache({ ttlMs: 0 }) },
    })
    await small.ready()
    try {
      const t = await makeTrend()
      const a = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
      const b = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
      const r = (tok: string) =>
        small.inject({
          method: 'POST',
          url: `/v1/shared/${tok}/tiles/0/run`,
          headers: { 'content-type': 'application/json' },
          payload: { range: '7d' },
        })
      expect((await r(a.token)).statusCode).toBe(200)
      expect((await r(a.token)).statusCode).toBe(200)
      const third = await r(a.token)
      expect(third.statusCode).toBe(429)
      expect(third.json()).toEqual({ error: 'too_many_runs' })
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
      expect((await r(b.token)).statusCode).toBe(200)
    } finally {
      await small.close()
    }
  })

  it('429 past the in-flight cap, and admits again on release', async () => {
    // Stub ClickHouse: `runStats` resolves only when the test releases it.
    const gates: (() => void)[] = []
    statsSpy.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve({ buckets: [] }))),
    )
    const small = buildApp({
      config,
      pg,
      ch,
      readiness,
      shared: { inFlight: new InFlightCap(1), cache: new ResultCache({ ttlMs: 0 }) },
    })
    await small.ready()
    try {
      const t = await makeTrend()
      const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
      const post = (range: string) =>
        small.inject({
          method: 'POST',
          url: `/v1/shared/${token}/tiles/0/run`,
          headers: { 'content-type': 'application/json' },
          payload: { range },
        })
      const first = post('7d')
      await vi.waitFor(() => expect(gates).toHaveLength(1))
      const second = await post('30d')
      expect(second.statusCode).toBe(429)
      expect(second.headers['retry-after']).toBe('1')
      gates[0]?.()
      expect((await first).statusCode).toBe(200)
      const third = post('30d')
      await vi.waitFor(() => expect(gates).toHaveLength(2))
      gates[1]?.()
      expect((await third).statusCode).toBe(200)
    } finally {
      statsSpy.mockRestore()
      await small.close()
    }
  })

  it('a cache hit counts toward neither limit', async () => {
    const small = buildApp({
      config,
      pg,
      ch,
      readiness,
      shared: { limiter: new AttemptLimiter(1, 60_000) },
    })
    await small.ready()
    try {
      const t = await makeTrend()
      const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
      const r = () =>
        small.inject({
          method: 'POST',
          url: `/v1/shared/${token}/tiles/0/run`,
          headers: { 'content-type': 'application/json' },
          payload: { range: '7d' },
        })
      expect((await r()).statusCode).toBe(200)
      expect((await r()).statusCode).toBe(200) // cached: not a second attempt
      expect((await r()).statusCode).toBe(200)
    } finally {
      await small.close()
    }
  })

  it('refuses while draining, like every other surface', async () => {
    const { token } = await sharedDashboard([])
    const draining = new Readiness()
    draining.markReady()
    draining.markDraining()
    const small = buildApp({ config, pg, ch, readiness: draining })
    await small.ready()
    const byShareToken = vi.spyOn(DashboardStore.prototype, 'byShareToken')
    try {
      // Before the token pattern check, so a draining server answers 503 to
      // everything on this surface rather than 404 to some of it.
      expect(
        (await small.inject({ method: 'GET', url: `/v1/shared/${'C'.repeat(43)}` })).statusCode,
      ).toBe(503)
      expect(
        (await small.inject({ method: 'GET', url: '/v1/shared/not-a-token' })).statusCode,
      ).toBe(503)
      // And it REFUSES rather than merely answering 503 on the way past: a
      // real token, one that would resolve, still reaches no query. That is
      // what `refuseIfDraining`'s `return null` buys -- without it the reply
      // is already sent but the work still runs, which is precisely what a
      // drain exists to stop.
      expect((await small.inject({ method: 'GET', url: `/v1/shared/${token}` })).statusCode).toBe(
        503,
      )
      expect(byShareToken).not.toHaveBeenCalled()
    } finally {
      byShareToken.mockRestore()
      await small.close()
    }
  })
})
