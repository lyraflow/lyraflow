import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import type { Project } from '../auth/project-cache.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { IngestBuffer } from './buffer.js'
import { IngestCounters } from './counters.js'
import { NullGeoResolver } from './geo.js'
import { CardinalityTracker } from './limits.js'
import { type IngestDeps, registerIngestRoutes } from './routes.js'
import type { EventRow } from './row.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
let app: FastifyInstance
let config: Config

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Routes', 'routes-test', 'wk_routes', 'h')`,
  )

  config = loadConfig({
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
  // Several tests above (e.g. the batch test) trigger an auto-flush via
  // flushRows without waiting on it. Draining before ch.close() keeps that
  // fire-and-forget insert from being severed mid-flight by the client
  // shutdown, which otherwise logs a spurious ECONNRESET through onError.
  await app.deps.buffer.flush()
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
  await pg.end()
  await ch.close()
})

function track(body: Record<string, unknown>, key = 'wk_routes') {
  return app.inject({
    method: 'POST',
    url: '/v1/track',
    headers: { 'x-lyraflow-write-key': key, 'user-agent': UA },
    payload: body,
  })
}

describe('ingest routes', () => {
  it('accepts a valid event with 202', async () => {
    const res = await track({
      message_id: randomUUID(),
      anonymous_id: 'a-routes',
      event: 'signup',
      properties: { plan: 'trial' },
    })
    expect(res.statusCode).toBe(202)
  })

  it('writes the event to ClickHouse', async () => {
    const id = randomUUID()
    await track({ message_id: id, anonymous_id: 'a-routes', event: 'persisted' })
    await app.deps.buffer.flush()
    const rs = await ch.query({
      query: `SELECT count() AS c FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBe(1)
  })

  it('rejects an unknown write key with 401', async () => {
    const res = await track({ message_id: randomUUID(), anonymous_id: 'a', event: 'x' }, 'wk_bad')
    expect(res.statusCode).toBe(401)
  })

  it('returns 202 for a malformed payload and records a dead letter', async () => {
    const res = await track({ message_id: 'not-a-uuid', event: 'x' })
    expect(res.statusCode).toBe(202)
    const rs = await ch.query({
      query: "SELECT count() AS c FROM events_dead_letter WHERE reason = 'validation_failed'",
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBeGreaterThan(0)
  })

  it('drops bot traffic without writing an event', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: { message_id: id, anonymous_id: 'a-bot', event: 'signup' },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    const rs = await ch.query({
      query: `SELECT count() AS c FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBe(0)
  })

  it('accepts a batch and reports per-item outcomes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a-b', event: 'one' },
          { type: 'track', message_id: 'bad', anonymous_id: 'a-b', event: 'two' },
        ],
      },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 })
  })

  it('refuses new events with 503 once draining', async () => {
    // A dedicated app + Readiness, not the shared fixture: Readiness has no
    // "un-drain" (draining is meant to be one-directional, same as
    // production), so mutating the shared instance would leave every test
    // that runs after this one permanently 503ing.
    const drainingReadiness = new Readiness()
    drainingReadiness.markReady()
    const drainingApp = buildApp({ config, pg, ch, readiness: drainingReadiness })
    await drainingApp.ready()
    drainingReadiness.markDraining()

    const res = await drainingApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: randomUUID(), anonymous_id: 'a', event: 'x' },
    })
    expect(res.statusCode).toBe(503)

    await drainingApp.close()
  })

  it('returns 503 rather than 500 when Postgres is unreachable and the cache has no prior entry', async () => {
    // Nothing listens on this port, so the very first ProjectCache lookup
    // rejects with no cached value to fall back on — the cold-cache-during-an-
    // outage case rule 1 protects. Without app.setErrorHandler, that
    // unhandled rejection would fall through to Fastify's default 500.
    const brokenPg = createPgPool('postgres://lyraflow:lyraflow@localhost:1/lyraflow_test')
    const brokenReadiness = new Readiness()
    brokenReadiness.markReady()
    const brokenApp = buildApp({ config, pg: brokenPg, ch, readiness: brokenReadiness })
    await brokenApp.ready()

    const res = await brokenApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: randomUUID(), anonymous_id: 'a', event: 'x' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')

    await brokenApp.close()
    await brokenPg.end().catch(() => {
      // The pool never established a real connection; end() may itself
      // reject on some platforms. Either way there is nothing left to clean up.
    })
  })
})

/**
 * Routes exercised here with fully mocked IngestDeps rather than buildApp,
 * so each test can force a specific failure mode (a synchronous throw from
 * the ClickHouse client, a saturated buffer) deterministically instead of
 * fighting real Postgres/ClickHouse into that state.
 */
describe('ingest routes (mocked deps)', () => {
  const project: Project = {
    id: 99,
    slug: 'mocked',
    retentionMonths: 24,
    monthlyEventQuota: 1_000_000,
  }

  // Minimal fakes satisfying only the methods routes.ts actually calls; cast
  // through `unknown` since they don't implement the full class surface —
  // the same pattern counters.test.ts already uses for a fake Pool.
  const projects = {
    byWriteKey: async (key: string) => (key === 'wk_mock' ? project : null),
    byServerKey: async () => null,
  } as unknown as IngestDeps['projects']
  const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool
  const okCh = { insert: async () => {} } as unknown as ClickHouseClient

  function buildMockedApp(overrides: Partial<IngestDeps> = {}) {
    const app = Fastify({ logger: false })
    const readiness = new Readiness()
    readiness.markReady()

    const deps: IngestDeps = {
      buffer: new IngestBuffer<EventRow>({
        flushRows: 1000,
        flushIntervalMs: 60_000,
        maxRows: 1000,
        insert: async () => {},
      }),
      projects,
      counters: new IngestCounters(fakePool),
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: okCh,
      ...overrides,
    }
    registerIngestRoutes(app, deps)
    return app
  }

  it('does not fail the request when a dead-letter write throws synchronously', async () => {
    const throwingCh = {
      insert: () => {
        throw new Error('client not connected') // synchronous, not a rejected promise
      },
    } as unknown as ClickHouseClient

    const mockedApp = buildMockedApp({ ch: throwingCh })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { message_id: 'not-a-uuid', event: 'x' }, // fails validation -> dead-letter path
    })
    expect(res.statusCode).toBe(202)
    await mockedApp.close()
  })

  it('writes all dead letters from one batch in a single ClickHouse insert call', async () => {
    const insertCalls: Array<{ values: unknown[] }> = []
    const countingCh = {
      insert: async (opts: { values: unknown[] }) => {
        insertCalls.push(opts)
      },
    } as unknown as ClickHouseClient

    const mockedApp = buildMockedApp({ ch: countingCh })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: 'bad-1', anonymous_id: 'a', event: 'x' },
          { type: 'track', message_id: 'bad-2', anonymous_id: 'a', event: 'x' },
          { type: 'track', message_id: 'bad-3', anonymous_id: 'a', event: 'x' },
        ],
      },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 0, rejected: 3 })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.values).toHaveLength(3)
    await mockedApp.close()
  })

  it('stops a batch and returns 503 once the buffer saturates, rather than treating overload as rejected', async () => {
    const saturatingBuffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1, // first add() succeeds; every add() after reports 'overloaded'
      insert: async () => {},
    })

    const mockedApp = buildMockedApp({ buffer: saturatingBuffer })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'one' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'two' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'three' },
        ],
      },
    })

    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    // Item 1 was accepted before saturation hit; items 2 and 3 were never
    // attempted (throttled), and none is folded into `rejected` — a
    // retry-able condition must stay distinguishable from bad data.
    expect(res.json()).toEqual({ accepted: 1, rejected: 0, throttled: 2 })
    await mockedApp.close()
  })
})
