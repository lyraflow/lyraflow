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

  // /v1/identify and /v1/page had no coverage at any level — only their
  // registrations — on an API the project promises to keep backward compatible
  // forever. Deleting either `app.post` line used to leave the suite green.

  it('accepts an identify event and stores it as $identify', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: id, user_id: 'u-routes', traits: { plan: 'pro' } },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name, user_id, properties['plan'] AS plan FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string; user_id: string; plan: string }>()
    // traits land in the same property maps as track properties, and the
    // event name is synthesised — both are contract, not incidental.
    expect(rows[0]).toEqual({ event_name: '$identify', user_id: 'u-routes', plan: 'pro' })
  })

  it('accepts a page event and uses its name as the event name', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/page',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: {
        message_id: id,
        anonymous_id: 'a-page',
        name: 'Pricing',
        context: { path: '/pricing' },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name, path FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string; path: string }>()
    expect(rows[0]).toEqual({ event_name: 'Pricing', path: '/pricing' })
  })

  it('falls back to $page when a page event carries no name', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/page',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: id, anonymous_id: 'a-page' },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string }>()
    expect(rows[0]?.event_name).toBe('$page')
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
    // throttled is always present (even at 0) so an SDK parsing a stable
    // shape never has to special-case its absence.
    expect(res.json()).toEqual({ accepted: 1, rejected: 1, throttled: 0 })
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

  it('returns 400 for a malformed JSON body, not 503', async () => {
    // Fastify's own body parser throws this before any route handler runs,
    // already carrying the correct 400. The /v1/* error handler must pass a
    // sub-500 status straight through instead of converting it to 503 — bad
    // JSON is a deterministic client error, not something retrying will fix.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: {
        'x-lyraflow-write-key': 'wk_routes',
        'user-agent': UA,
        'content-type': 'application/json',
      },
      payload: '{not valid json',
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 413 for a body over bodyLimit, not 503', async () => {
    // Well-formed JSON, but its serialized size exceeds buildApp's
    // bodyLimit (1_048_576 bytes) — Fastify rejects it before parsing, with
    // a genuine 413. Retrying an oversized body will fail again every time,
    // so this must not become 503 either.
    const oversized = {
      message_id: randomUUID(),
      anonymous_id: 'a',
      event: 'x',
      properties: { blob: 'x'.repeat(2_000_000) },
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: oversized,
    })
    expect(res.statusCode).toBe(413)
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

  it('logs a failing dead-letter write rather than swallowing it', async () => {
    // events_dead_letter is the only record of rejected data, so a
    // persistently failing write makes bad-data debugging impossible. Not
    // failing the request is right; being silent about it is not.
    const lines: string[] = []
    const app = Fastify({
      logger: {
        level: 'error',
        stream: {
          write: (line: string) => {
            lines.push(line)
          },
        },
      },
    })
    const readiness = new Readiness()
    readiness.markReady()
    registerIngestRoutes(app, {
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
      ch: {
        insert: async () => {
          throw new Error('clickhouse unreachable')
        },
      } as unknown as ClickHouseClient,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { message_id: 'not-a-uuid', event: 'x' }, // fails validation -> dead-letter path
    })

    expect(res.statusCode).toBe(202) // still must not fail the caller
    // Catches the mutation of restoring the bare `catch {}`: no line is
    // emitted, and a broken dead-letter path stays invisible forever.
    const logged = lines.join('')
    expect(logged).toContain('dead-letter write failed')
    expect(logged).toContain('clickhouse unreachable')
    await app.close()
  })

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
    expect(res.json()).toEqual({ accepted: 0, rejected: 3, throttled: 0 })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.values).toHaveLength(3)
    await mockedApp.close()
  })

  it('dead-letters a malformed batch envelope as one rejection without touching the items', async () => {
    // The envelope-failure branch of /v1/batch (BatchPayload.safeParse
    // failing) had no coverage. `batch: []` violates the .min(1) bound, so
    // this exercises the branch that answers 202 with rejected: 1 and writes
    // exactly one dead letter for the whole request. Deleting that branch's
    // writeDeadLetters call, or folding it into the per-item loop, changes
    // what this asserts.
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
      payload: { batch: [] },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 0, rejected: 1, throttled: 0 })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.values).toHaveLength(1)
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

  it('counts every un-attempted batch item as throttled, matching the response body exactly', async () => {
    const saturatingBuffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1, // first add() succeeds; every add() after reports 'overloaded'
      insert: async () => {},
    })
    const counters = new IngestCounters(fakePool)

    const mockedApp = buildMockedApp({ buffer: saturatingBuffer, counters })
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

    const body = res.json() as { accepted: number; rejected: number; throttled: number }
    // This equality is the invariant that matters: the metric/quota counter
    // and the response the SDK sees must never disagree about how many
    // events were throttled. accept() only counts the one item it actually
    // attempted (item i) — the batch.length - i - 1 items the loop never
    // reached must be recorded too, or a dashboard reads 1 while the SDK
    // retries 2.
    expect(counters.totals().throttled).toBe(body.throttled)
    expect(body.throttled).toBe(2)
    await mockedApp.close()
  })
})
