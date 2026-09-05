import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Writable } from 'node:stream'
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
import { InFlightCap, ResultCache, SHARED_MAX_IN_FLIGHT } from './limits.js'

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
const OTHER_WRITE_KEY = 'wk_shared_routes_other'
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
    [OTHER_WRITE_KEY, hashServerKey(OTHER_SERVER_KEY)],
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

/** One event into whichever project owns `writeKey`, flushed -- the 202
 *  returns before the row has landed in ClickHouse, and every read below
 *  needs it to have landed. Same shape privacy/end-to-end.test.ts uses. */
async function track(writeKey: string, event: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/track',
    headers: { 'x-lyraflow-write-key': writeKey, 'content-type': 'application/json' },
    payload: {
      message_id: randomUUID(),
      anonymous_id: randomUUID(),
      type: 'track',
      event,
      timestamp: new Date().toISOString(),
    },
  })
  expect(res.statusCode).toBe(202)
  await app.deps.buffer.flush()
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
    // A credentialed read: no intermediary on the path to a shared link is
    // one anybody chose.
    expect(res.headers['cache-control']).toBe('no-store')
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

  it('never writes the token into a request log line', async () => {
    // pino writes to stdout, so the only way to read a real log line is to
    // hand the app somewhere else to write -- see `buildApp`'s `logStream`
    // seam. This is the whole reason `redactShareToken` exists: the share
    // token is the only credential in the product that travels in a URL
    // path, and Fastify's default serializer logs `req.url` on every
    // request at `info`.
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const logged = buildApp({ config, pg, ch, readiness, logStream: stream })
    await logged.ready()
    try {
      const t = await makeTrend()
      const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
      expect((await logged.inject({ method: 'GET', url: `/v1/shared/${token}` })).statusCode).toBe(
        200,
      )
      expect(
        (
          await logged.inject({
            method: 'POST',
            url: `/v1/shared/${token}/tiles/0/run`,
            headers: { 'content-type': 'application/json' },
            payload: { range: '7d' },
          })
        ).statusCode,
      ).toBe(200)

      const shared = lines.filter((l) => l.includes('/v1/shared'))
      expect(shared.length).toBeGreaterThan(0)
      for (const line of shared) expect(line).not.toContain(token)
      expect(shared.some((l) => l.includes('/v1/shared/[redacted]'))).toBe(true)
      expect(shared.some((l) => l.includes('/v1/shared/[redacted]/tiles/0/run'))).toBe(true)
      // The rest of the default serializer survives being replaced.
      const first = JSON.parse(shared[0] ?? '{}')
      expect(first.req).toMatchObject({ method: expect.any(String), remoteAddress: '127.0.0.1' })
    } finally {
      await logged.close()
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
    // A credentialed read, like the GET: never stored by anything on the
    // path to a shared link, which is a path nobody chose.
    expect(a.headers['cache-control']).toBe('no-store')
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
    // The project comes from the TOKEN, never from the request: the shared
    // run and the operator's own call are scoped to the same project id.
    expect(statsSpy.mock.calls[0]?.[1]).toEqual({ id: projectId })
    // The operator's route passes its whole authenticated project record;
    // only the id has to agree.
    expect(statsSpy.mock.calls[1]?.[1]).toMatchObject({ id: projectId })
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
    expect(retentionSpy.mock.calls[0]?.[1]).toEqual({ id: projectId })
    expect(retentionSpy.mock.calls[1]?.[1]).toMatchObject({ id: projectId })
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

  it("reads only the token's own project, whatever key rides along", async () => {
    // The project id comes from `DashboardStore.byShareToken`, never from
    // the request -- there is no authentication here to influence, and a
    // server key presented alongside is simply ignored. An empty result on
    // its own would prove nothing, so this ingests into the OTHER project
    // first (which must not be counted) and then into this one (which
    // must).
    const event = `xproj_${randomUUID().replace(/-/g, '')}`
    const t = (
      await call('POST', '/v1/trends', { name: `x-${Math.random()}`, event, interval: '1d' })
    ).json().id
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])

    await track(OTHER_WRITE_KEY, event)
    await track(OTHER_WRITE_KEY, event)
    const blind = await app.inject({
      method: 'POST',
      url: `/v1/shared/${token}/tiles/0/run`,
      // The other project's server key, on the request, ignored.
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': OTHER_SERVER_KEY },
      payload: { range: '7d' },
    })
    expect(blind.statusCode).toBe(200)
    expect(blind.json().result.buckets).toEqual([])

    await track(WRITE_KEY, event)
    // A different preset, so this is a fresh run rather than the cached one.
    const own = await run(token, 0, '30d')
    expect(own.statusCode).toBe(200)
    const total = (own.json().result.buckets as { events: number }[]).reduce(
      (n, b) => n + b.events,
      0,
    )
    expect(total).toBe(1)
  })

  it('a failed run releases its in-flight slot', async () => {
    // Without `finally`, a slot leaks on every failure and the cap wedges
    // the link shut for the process's lifetime -- which is worse than the
    // outage that caused it, because it outlives it.
    statsSpy.mockImplementation(() => Promise.reject(new Error('clickhouse is down (simulated)')))
    const t = await makeTrend()
    const { token } = await sharedDashboard([{ kind: 'trend', report_id: t, width: 'half' }])
    for (let i = 0; i < SHARED_MAX_IN_FLIGHT; i++) {
      const failed = await run(token, 0, '7d')
      expect(failed.statusCode).toBe(503)
    }
    statsSpy.mockRestore()
    const after = await run(token, 0, '7d')
    expect(after.statusCode).not.toBe(429)
    expect(after.statusCode).toBe(200)
  })

  it('runs a retention tile at auto with no bounds of its own', async () => {
    const r = await makeRetention()
    const { token } = await sharedDashboard([{ kind: 'retention', report_id: r, width: 'half' }])
    expect((await run(token, 0, 'auto')).statusCode).toBe(200)
    const sent = retentionSpy.mock.calls[0]?.[2]
    expect(sent?.since).toBeUndefined()
    expect(sent?.until).toBeUndefined()
  })

  it("refuses a funnel preset the funnel's own run would refuse", async () => {
    // 180 days at a 1-hour window is the funnel compiler's own ceiling, and
    // the shared route hands back exactly the code it raises rather than
    // inventing one.
    const f = await makeFunnel()
    const { token } = await sharedDashboard([{ kind: 'funnel', report_id: f, width: 'full' }])
    const res = await run(token, 0, '180d')
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBeDefined()
  })

  it('refuses a funnel whose stored definition this build cannot read', async () => {
    const f = await makeFunnel()
    // `FunnelStore` parses `steps` with `z.array(FunnelStep).min(2)` and
    // THROWS `StoredDefinitionError` rather than flagging, unlike the trend
    // and retention stores. A one-step array is jsonb the column accepts
    // and that schema refuses.
    await pg.query(`UPDATE funnels SET steps = '[{"event":"a"}]'::jsonb WHERE id = $1`, [f])
    const { token } = await sharedDashboard([{ kind: 'funnel', report_id: f, width: 'full' }])
    const res = await run(token, 0, '7d')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeDefined()
  })

  it('refuses a stored retention definition the run schema will not accept', async () => {
    // REACHABLE, not defensive: `020_saved_reports.sql` bounds `periods`
    // only by `> 0`, while `RetentionBody` caps it at MAX_PERIODS (26). Such
    // a row is NOT stale -- `stale` is computed from the `where` columns
    // alone -- so it reaches the body parse with everything else intact.
    const r = await makeRetention()
    await pg.query('UPDATE retention_reports SET periods = 999 WHERE id = $1', [r])
    const { token } = await sharedDashboard([{ kind: 'retention', report_id: r, width: 'half' }])
    const res = await run(token, 0, '7d')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'validation_failed' })
    expect(retentionSpy).not.toHaveBeenCalled()
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

  it('an in-flight refusal is not charged against the window', async () => {
    // `limiter.record` comes AFTER `inFlight.acquire`, and this is what
    // that ordering buys: a request the cap turned away never ran, so
    // charging it would let a burst of concurrent tiles eat a link's whole
    // minute for work nobody did.
    //
    // Two attempts and one slot, so the ordering is the only thing that
    // decides the third request. Correct order: run 1 records (1 of 2), run
    // 2 is refused by the cap and records nothing, run 3 records (2 of 2)
    // and SUCCEEDS. Wrong order: run 2's refusal records anyway (2 of 2)
    // and run 3 is a 429 from the window instead.
    const gates: (() => void)[] = []
    statsSpy.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve({ buckets: [] }))),
    )
    const small = buildApp({
      config,
      pg,
      ch,
      readiness,
      shared: {
        limiter: new AttemptLimiter(2, 60_000),
        inFlight: new InFlightCap(1),
        cache: new ResultCache({ ttlMs: 0 }),
      },
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
      const refused = await post('30d')
      expect(refused.statusCode).toBe(429)
      expect(refused.headers['retry-after']).toBe('1')
      gates[0]?.()
      expect((await first).statusCode).toBe(200)

      const third = post('90d')
      await vi.waitFor(() => expect(gates).toHaveLength(2))
      gates[1]?.()
      expect((await third).statusCode).toBe(200)

      // And the window is genuinely spent now -- the two that RAN used it,
      // so this proves the run above was admitted by the limiter rather
      // than by the limiter having no teeth.
      const fourth = await post('180d')
      expect(fourth.statusCode).toBe(429)
      expect(fourth.headers['retry-after']).toBe(String(Math.ceil(60_000 / 1000)))
    } finally {
      statsSpy.mockRestore()
      await small.close()
    }
  })

  it('a page load counts against the same per-token window as a run', async () => {
    // One link's ceiling is 120 REQUESTS a minute, not 120 runs on top of
    // unlimited resolves: the GET resolves the token and reads every report
    // on the dashboard, which is not free, and leaving it uncounted would
    // make it the cheap way to hammer a link.
    const small = buildApp({
      config,
      pg,
      ch,
      readiness,
      shared: { limiter: new AttemptLimiter(1, 60_000) },
    })
    await small.ready()
    try {
      const a = await sharedDashboard([])
      const b = await sharedDashboard([])
      const get = (tok: string) => small.inject({ method: 'GET', url: `/v1/shared/${tok}` })
      expect((await get(a.token)).statusCode).toBe(200)
      const second = await get(a.token)
      expect(second.statusCode).toBe(429)
      expect(second.json()).toEqual({ error: 'too_many_runs' })
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0)
      // Per token, not global.
      expect((await get(b.token)).statusCode).toBe(200)
    } finally {
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
