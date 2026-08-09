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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { type Project, ProjectCache } from '../auth/project-cache.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { IngestBuffer } from './buffer.js'
import { monthStart, readCounterRow, seedCounterRow } from './counter-fixtures.js'
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
    expect(res.json()).toEqual({ accepted: 1, rejected: 1, throttled: 0, over_quota: 0 })
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
    serverKeyHash: 'mocked-server-key-hash',
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
  // None of the fixtures in this file exercise identify with both ids, so
  // these fakes only need to satisfy IngestDeps's shape — identity-routes.test.ts
  // is where bindings/aliases behaviour is actually exercised.
  const bindings = { bind: async () => 'noop' as const } as unknown as IngestDeps['bindings']
  const aliases = { alias: async () => 'noop' as const } as unknown as IngestDeps['aliases']

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
      bindings,
      aliases,
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
      bindings,
      aliases,
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
    expect(res.json()).toEqual({ accepted: 0, rejected: 3, throttled: 0, over_quota: 0 })
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
    expect(res.json()).toEqual({ accepted: 0, rejected: 1, throttled: 0, over_quota: 0 })
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
    expect(res.json()).toEqual({ accepted: 1, rejected: 0, throttled: 2, over_quota: 0 })
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

/**
 * Quota enforcement, driven through the real HTTP path against live
 * Postgres — a real ProjectCache, a real IngestCounters, a real
 * CardinalityTracker — with only ClickHouse faked, since none of these
 * assertions is about what was stored there.
 *
 * DEFEATING THE PROJECT CACHE. buildApp's ProjectCache holds a positive
 * entry for 60 seconds, so `setQuota` followed by a request would otherwise
 * be answered from a project loaded before the quota existed, and every test
 * here would pass or fail on whether the cache happened to be cold. This
 * block therefore builds its own app around `new ProjectCache(pg, 0)`: a
 * zero TTL makes `#read` report every entry as stale, so each request
 * re-reads the project and sees the quota the test just set. That is a
 * deliberate, visible construction rather than a lucky one — the tests do
 * not touch cache internals, and they do not depend on ordering.
 *
 * A FRESH APP PER TEST for the same class of reason: the persisted-usage
 * cache and the pending tallies both live for the lifetime of one
 * registration, and sharing either across tests would make each test's
 * result depend on the ones before it.
 */
describe('ingest quota enforcement', () => {
  const SLUG = 'routes-quota-test'
  const WRITE_KEY = 'wk_routes_quota'
  // A second project, used only by the cross-project test. Every other test
  // here drives one project, which is exactly why that test is needed.
  const SLUG_B = 'routes-quota-test-b'
  const WRITE_KEY_B = 'wk_routes_quota_b'

  let projectId: number
  let projectIdB: number
  let quotaApp: FastifyInstance
  let counters: IngestCounters
  let buffer: IngestBuffer<EventRow>
  let stored: EventRow[]
  let deadLetterInserts: number
  let usageReads: number

  // Counts only the quota's own usage SELECT (IngestCounters.persistedAccepted)
  // and forwards everything to the real pool. flush()'s `INSERT INTO
  // ingest_counters` deliberately does not match. This is what lets a test
  // assert the difference between "one read per project per TTL" and "one
  // read per event", which no assertion on status codes can see.
  const countingPg = {
    query: (text: string, values?: unknown[]) => {
      if (text.includes('FROM ingest_counters')) usageReads++
      return pg.query(text, values)
    },
  } as unknown as Pool

  const bindings = { bind: async () => 'noop' as const } as unknown as IngestDeps['bindings']
  const aliases = { alias: async () => 'noop' as const } as unknown as IngestDeps['aliases']

  function validEvent(): Record<string, unknown> {
    return { message_id: randomUUID(), anonymous_id: 'a-quota', event: 'quota' }
  }

  function post(url: string, payload: unknown, key = WRITE_KEY) {
    return quotaApp.inject({
      method: 'POST',
      url,
      headers: { 'x-lyraflow-write-key': key, 'user-agent': UA },
      payload: payload as Record<string, unknown>,
    })
  }

  async function setQuota(quota: number | null, id = projectId): Promise<void> {
    await pg.query('UPDATE projects SET monthly_event_quota = $2 WHERE id = $1', [id, quota])
  }

  /**
   * The wiring every test in this block shares: real Postgres behind a real
   * ProjectCache with a zero TTL (see this describe's own docstring), real
   * counters, a capturing buffer, and a counting ClickHouse fake. A test that
   * needs a different pool, a shorter usage TTL or a real logger passes
   * overrides rather than hand-rolling the whole registration, so no variant
   * can quietly differ from the default in some second respect.
   */
  function buildQuotaApp(overrides: Partial<IngestDeps> = {}, app?: FastifyInstance) {
    const readiness = new Readiness()
    readiness.markReady()
    const instance = app ?? Fastify({ logger: false })
    registerIngestRoutes(instance, {
      buffer,
      projects: new ProjectCache(pg, 0),
      counters,
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: {
        insert: async () => {
          deadLetterInserts++
        },
      } as unknown as ClickHouseClient,
      bindings,
      aliases,
      ...overrides,
    })
    return instance
  }

  beforeAll(async () => {
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_B]])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Routes Quota', $1, $2, 'h') RETURNING id`,
      [SLUG, WRITE_KEY],
    )
    projectId = Number(r.rows[0]?.id)
    const b = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Routes Quota B', $1, $2, 'h') RETURNING id`,
      [SLUG_B, WRITE_KEY_B],
    )
    projectIdB = Number(b.rows[0]?.id)
  })

  afterAll(async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = ANY($1)', [
      [projectId, projectIdB],
    ])
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_B]])
  })

  beforeEach(async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = ANY($1)', [
      [projectId, projectIdB],
    ])
    await setQuota(null)
    await setQuota(null, projectIdB)
    usageReads = 0
    deadLetterInserts = 0
    stored = []
    counters = new IngestCounters(countingPg)
    buffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1000,
      insert: async (rows) => {
        stored.push(...rows)
      },
    })
    quotaApp = buildQuotaApp()
    await quotaApp.ready()
  })

  afterEach(async () => {
    await quotaApp.close()
  })

  it('answers 429 with quota_exceeded once the project is over', async () => {
    await setQuota(2)
    await post('/v1/track', validEvent()) // 1
    await post('/v1/track', validEvent()) // 2
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'quota_exceeded' })
  })

  it('sends no retry-after on a quota refusal', async () => {
    // 503 means "the buffer is full, come back shortly" and carries
    // retry-after. A quota refusal holds until the month rolls over, so the
    // header's presence would invite exactly the retry this design prevents.
    await setQuota(1)
    await post('/v1/track', validEvent())
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('never counts a refusal toward the quota it reports', async () => {
    // Otherwise the hole deepens as it is reported, and events_accepted
    // diverges from what was actually stored.
    await setQuota(1)
    await post('/v1/track', validEvent())
    await post('/v1/track', validEvent())
    await post('/v1/track', validEvent())
    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_accepted).toBe('1')
    expect(row.events_over_quota).toBe('2')
  })

  it('a flood of INVALID events never exhausts the quota', async () => {
    // THE attack this design turns on. Rejected events store nothing, so
    // counting them would let an attacker burn a project's quota for free --
    // cheaper than the flood the quota exists to stop.
    await setQuota(3)
    for (let i = 0; i < 50; i++) await post('/v1/track', { nonsense: true })
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(202)
  })

  it('lets an unlimited project through without reading usage', async () => {
    await setQuota(null)
    for (let i = 0; i < 20; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    // The brief's title asserted "without reading usage" and nothing checked
    // it. A quota of null is decided from the project row alone, so the
    // usage table must never be touched: on a deployment that has set no
    // quota -- which, after migration 011, is every deployment -- this is
    // the difference between zero Postgres round trips on the hot path and
    // one per project per TTL forever.
    expect(usageReads).toBe(0)
  })

  it('a batch entirely over quota still answers 202, reporting the counts', async () => {
    // /v1/batch never fails wholesale over one event -- its contract is a 202
    // carrying the tally. The SDK's own reporting path reads that body.
    await setQuota(1)
    await post('/v1/track', validEvent())
    const res = await post('/v1/batch', {
      batch: [
        { type: 'track', ...validEvent() },
        { type: 'track', ...validEvent() },
      ],
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: 0, over_quota: 2 })
    // Not folded into `rejected`: these events are well-formed, and an SDK
    // told they were rejected would warn the developer about bad data that
    // does not exist.
    expect(res.json()).toEqual({ accepted: 0, rejected: 0, throttled: 0, over_quota: 2 })
  })

  // --- Not in the brief. ---

  it('refuses on the PERSISTED total alone, before this process has accepted anything', async () => {
    // Every prescribed test above drives the count entirely through this
    // process's pending tally, so an implementation that ignored
    // persistedAccepted and compared `pending >= quota` would pass all six
    // -- and would reset every project's usage to zero on each restart,
    // which is a quota that can be cleared by rebooting the server.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
    await setQuota(5)
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(usageReads).toBe(1)
  })

  it('counts only the current month of persisted usage', async () => {
    // The mirror of the test above: a previous month's spend must not follow
    // a project into the new one, or every quota becomes permanent after the
    // first month that exhausts it.
    await seedCounterRow(pg, projectId, monthStart(-1), { accepted: 999 })
    await setQuota(5)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
  })

  it('still counts a MALFORMED event from an over-quota project as rejected, not over_quota', async () => {
    // The reason the check sits after validation, asserted directly. Moving
    // it earlier does NOT fail the invalid-flood test above -- that test is
    // protected by pendingAccepted summing only `accepted`, not by where the
    // check sits -- so nothing else here can see the difference. What moves
    // is the answer and the bookkeeping: a malformed event would come back
    // 429 instead of 202, breaking the rule that bad data never errors a
    // customer's site, and would land in events_over_quota with no dead
    // letter, leaving both counters unable to say what actually happened.
    await setQuota(1)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    const res = await post('/v1/track', { nonsense: true })
    expect(res.statusCode).toBe(202)
    expect(deadLetterInserts).toBe(1)

    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_rejected).toBe('1')
    expect(row.events_over_quota).toBe('0')
  })

  it('reads persisted usage once per project, not once per event', async () => {
    // The hot-path property, and nothing in the brief's six tests can see
    // it: all of them pass identically against a Postgres round trip per
    // event. Ten injected requests complete in milliseconds, far inside
    // QUOTA_USAGE_TTL_MS, so exactly one read is expected -- and a
    // per-event implementation produces ten.
    await setQuota(100)
    for (let i = 0; i < 10; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    expect(usageReads).toBe(1)
  })

  it('a refused event occupies neither the buffer nor the dead-letter table', async () => {
    // Placement, asserted rather than described: before buffer.add, so a
    // refusal costs no buffer memory (the resource IngestBuffer's maxRows
    // bound exists to protect), and with no dead letter, because the event
    // is valid and events_dead_letter is the record of data that could not
    // be parsed.
    await setQuota(1)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    await buffer.flush()
    expect(stored).toHaveLength(1)
    expect(deadLetterInserts).toBe(0)
  })

  it('keeps accepting events when the usage read itself fails, and says so in the log', async () => {
    // The quota check put a Postgres read on the hot path, so it also put
    // Postgres's availability there. A blip must not turn into a
    // project-wide refusal of events that were nowhere near the limit --
    // the same "stale beats unavailable" rule ProjectCache follows, and the
    // same priority the spec sets: keep collecting events. Failing closed
    // here would be an outage of the customer's analytics caused by an
    // outage of ours, and nothing else in this file would notice.
    //
    // It must not be silent either: a permanently failing usage read means
    // the quota is no longer being enforced from persisted state at all.
    const failingPg = {
      query: (text: string, values?: unknown[]) =>
        text.includes('FROM ingest_counters')
          ? Promise.reject(new Error('connection reset'))
          : pg.query(text, values),
    } as unknown as Pool

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
    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ counters: new IngestCounters(failingPg) }, app)
    await quotaApp.ready()
    await setQuota(5)

    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(202)
    expect(lines.join('')).toContain('quota usage read failed')
  })

  it('a FAILING usage read costs one Postgres attempt per TTL, not one per event', async () => {
    // The fail-open path is right; caching nothing on the way out was not.
    // Single-flight only coalesces requests that overlap a read's latency,
    // and the classic outage -- ECONNREFUSED against a Postgres that is
    // down -- fails in microseconds with nothing to overlap. Without a
    // negative entry, every subsequent event starts its own doomed query:
    // measured at 10 attempts for 10 sequential events and 200 for 200
    // concurrent ones. That inverts the one mechanism this task exists to
    // install into 1:1 with traffic, under exactly the condition that makes
    // queries expensive, driven by a public browser-shipped write key
    // against a `max: 10` pool.
    let attempts = 0
    const failingPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({
      counters: new IngestCounters(failingPg),
      // Long enough that the whole test runs inside one window, so the count
      // below is "attempts per outage", not "attempts per elapsed second".
      quotaUsageTtlMs: 60_000,
    })
    await quotaApp.ready()
    // Comfortably above the 410 events below: with the read failing, the
    // pending tally is the only thing enforcing the quota, and a small
    // quota would refuse events for that reason instead of exercising the
    // query count this test is about.
    await setQuota(100_000)

    for (let i = 0; i < 10; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    const wave = await Promise.all(
      Array.from({ length: 200 }, () => post('/v1/track', validEvent())),
    )
    expect(wave.every((r) => r.statusCode === 202)).toBe(true)
    const second = await Promise.all(
      Array.from({ length: 200 }, () => post('/v1/track', validEvent())),
    )
    expect(second.every((r) => r.statusCode === 202)).toBe(true)

    // 410 events, one query. Before the negative entry: 410.
    expect(attempts).toBe(1)
  })

  it('retries a failing usage read once the negative entry expires', async () => {
    // The other half of the bound: a failure must not disable the read for
    // the life of the process either, or a quota stops being enforced from
    // persisted state after the first blip and nothing ever reconsiders.
    let attempts = 0
    const failingPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({
      counters: new IngestCounters(failingPg),
      quotaUsageTtlMs: 20,
    })
    await quotaApp.ready()
    await setQuota(5)

    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(attempts).toBe(1)
    await new Promise((r) => setTimeout(r, 40))
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(attempts).toBe(2)
  })

  it('re-reads the persisted figure once the TTL expires, rather than freezing it', async () => {
    // The entire refresh half of the cache was unreachable: every other test
    // here finishes in milliseconds, far inside the production 5s TTL, so
    // three independent mutations left the suite green -- deleting the TTL
    // comparison (an entry that never expires), deleting the month test, and
    // deleting `.finally(() => usageInflight.delete(...))`.
    //
    // That last one is the severe member of the class: the settled promise
    // stays in the in-flight map forever, every later call falls through to
    // it, and its `.then` never runs again -- so the persisted figure
    // FREEZES at its first value for the life of the process. That is a
    // quota that resets on restart, which is the exact failure the
    // persisted-total test above exists to prevent, reached by another
    // route. Asserting on the decision rather than only on the query count
    // catches all three: a frozen or never-expiring figure still reads 0
    // here, and still answers 202.
    quotaApp = buildQuotaApp({ quotaUsageTtlMs: 20 })
    await quotaApp.ready()
    await setQuota(5)

    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(usageReads).toBe(1)

    // Someone else -- another process, or the counter flush -- moves the
    // project to its limit while this process holds a cached zero.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
    await new Promise((r) => setTimeout(r, 40))

    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect(usageReads).toBe(2)
  })

  it('discards a cached figure belonging to the previous month, inside the TTL', async () => {
    // The month test in the cache, which the TTL seam alone cannot reach:
    // this needs the clock to cross a month boundary while the entry is
    // still FRESH, or the TTL expiry would refetch anyway and prove nothing.
    //
    // Only Date is faked -- not setTimeout/setInterval -- so the live pool's
    // own timers and socket I/O are untouched and the queries below are
    // real. Faking all timers here would stall the pool instead.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 900)))
      await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
      await setQuota(5)

      // January is spent, so the project is refused.
      expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
      expect(usageReads).toBe(1)

      // 200ms later -- far inside the 5s TTL -- but a different month, in
      // which the project has spent nothing.
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 100)))
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
      expect(usageReads).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never lets one project's usage decide another project's quota", async () => {
    // Every other test in this block drives a single project, so keying the
    // usage map (and the in-flight map) by a constant leaves all of them
    // green. A cross-tenant quota leak is the highest-consequence thing this
    // cache can do -- one busy project silently refusing every other
    // project's events -- and nothing else here would notice it.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 50 })
    await setQuota(5)
    await setQuota(5, projectIdB)

    // A is far past its limit and must be refused; B has spent nothing and
    // must not be, even though A's figure is now cached.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect((await post('/v1/track', validEvent(), WRITE_KEY_B)).statusCode).toBe(202)
    // Two projects, two reads: B must not be answered from A's entry.
    expect(usageReads).toBe(2)
  })

  it('accepts exactly the quota and refuses the event after it', async () => {
    // Pins `>=` against `>`: with a quota of 3 the third event is the last
    // one inside the budget, and the fourth is the first outside it. A `>`
    // comparison lets every project store quota + 1.
    await setQuota(3)
    for (let i = 0; i < 3; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
  })
})
