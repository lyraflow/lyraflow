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
import { hashServerKey } from '../auth/project-cache.js'
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
let projectId: number

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const WRITE_KEY = 'wk_identity_routes'
const SERVER_KEY = 'sk_identity_routes'

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-routes-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Identity Routes', 'identity-routes-test', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(r.rows[0]?.id)

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
  await app.deps.buffer.flush()
  await app.close()
  await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
  await pg.query('DELETE FROM person_aliases WHERE project_id = $1', [projectId])
  await pg.query('DELETE FROM projects WHERE slug = $1', ['identity-routes-test'])
  await pg.end()
  await ch.close()
})

function identify(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/identify',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': UA },
    payload: body,
  })
}

function batch(items: Record<string, unknown>[]) {
  return app.inject({
    method: 'POST',
    url: '/v1/batch',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': UA },
    payload: { batch: items },
  })
}

function aliasReq(body: Record<string, unknown>, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/v1/alias',
    headers: { 'user-agent': UA, ...headers },
    payload: body,
  })
}

describe('POST /v1/identify writes a binding', () => {
  // Would catch: the binding write being dropped entirely, or bind() being
  // called with the wrong argument order (anonymous/user swapped).
  it('writes a binding when the payload carries both ids, and still returns 202', async () => {
    const res = await identify({
      message_id: randomUUID(),
      anonymous_id: 'a-bind-both',
      user_id: 'u-bind-both',
      traits: { plan: 'pro' },
    })
    expect(res.statusCode).toBe(202)

    const r = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2',
      [projectId, 'a-bind-both'],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.person_id).toBe('u-bind-both')
  })

  // Would catch: the anonymous_id-presence guard being dropped (or inverted),
  // which would either write a spurious binding for server-side-only
  // identify calls, or write no binding at all when both ids are present.
  it('writes no binding when the payload carries only user_id (server-side tracking)', async () => {
    const res = await identify({
      message_id: randomUUID(),
      user_id: 'u-only-server-side',
      traits: { plan: 'enterprise' },
    })
    expect(res.statusCode).toBe(202)

    const r = await pg.query(
      'SELECT count(*) c FROM identity_bindings WHERE project_id = $1 AND person_id = $2',
      [projectId, 'u-only-server-side'],
    )
    expect(Number((r.rows[0] as { c: string }).c)).toBe(0)
  })

  // THE test for the timestamp requirement. Would catch: the binding write
  // using `new Date()` (request-arrival time) instead of the event's own
  // clamped timestamp — every other assertion in this file uses a timestamp
  // close to "now" and would stay green under that substitution, so this
  // test deliberately uses a timestamp far enough in the past (1 hour) that
  // the two would visibly disagree.
  it('records the binding at the event own timestamp, not the time the request was received', async () => {
    const eventTime = new Date(Date.now() - 60 * 60 * 1000)
    const res = await identify({
      message_id: randomUUID(),
      anonymous_id: 'a-bind-ts',
      user_id: 'u-bind-ts',
      timestamp: eventTime.toISOString(),
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const r = await pg.query<{ bound_at: Date }>(
      'SELECT bound_at FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2',
      [projectId, 'a-bind-ts'],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.bound_at.getTime()).toBe(eventTime.getTime())
  })

  // accept() is shared by /v1/identify and each item of /v1/batch, and the
  // binding write lives inside accept() specifically so both paths get it.
  // Would catch: the binding logic being moved into single()'s handler
  // instead (or otherwise made reachable only from the standalone
  // /v1/identify route), which would leave a batch-borne identify
  // unbound while every other test in this file — all of which go through
  // /v1/identify directly — stayed green.
  it('writes a binding for an identify event carried inside /v1/batch', async () => {
    const res = await batch([
      {
        type: 'identify',
        message_id: randomUUID(),
        anonymous_id: 'a-bind-batch',
        user_id: 'u-bind-batch',
        traits: {},
      },
    ])
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 1, rejected: 0, throttled: 0, over_quota: 0, bot: 0 })

    const r = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2',
      [projectId, 'a-bind-batch'],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.person_id).toBe('u-bind-batch')
  })
})

describe('POST /v1/alias', () => {
  // THE test for rule 2: the public write key must not be accepted as a
  // server key, even though it authenticates fine against /v1/track etc.
  // Presented under x-lyraflow-server-key so this actually exercises
  // authenticateServer's hashed byServerKey lookup (routes.ts) rather than
  // its "header absent" branch — a write key's hash will never match a
  // project's server_key_hash. Would catch: swapping projects.byServerKey
  // for projects.byWriteKey (or any lookup that accepts a write key) in the
  // /v1/alias handler. Verified below by making exactly that mutation.
  it('rejects the write key presented as a server key with 401 — aliasing requires the secret server key, not the public write key', async () => {
    const res = await aliasReq(
      { from_user_id: 'alias-wk-a', to_user_id: 'alias-wk-b' },
      { 'x-lyraflow-server-key': WRITE_KEY },
    )
    expect(res.statusCode).toBe(401)
  })

  // Would catch: the "no key at all" branch answering something other than
  // 401, e.g. falling through to an unauthenticated call to aliases.alias().
  it('rejects a request with no server key header at all', async () => {
    const res = await aliasReq({ from_user_id: 'alias-nk-a', to_user_id: 'alias-nk-b' }, {})
    expect(res.statusCode).toBe(401)
  })

  it('merges two people given a valid server key', async () => {
    const res = await aliasReq(
      { from_user_id: 'alias-merge-a', to_user_id: 'alias-merge-b' },
      { 'x-lyraflow-server-key': SERVER_KEY },
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'merged' })

    const r = await pg.query<{ canonical_id: string }>(
      'SELECT canonical_id FROM person_aliases WHERE project_id = $1 AND person_id = $2',
      [projectId, 'alias-merge-a'],
    )
    expect(r.rows[0]?.canonical_id).toBe('alias-merge-b')
  })

  it('is a no-op when both people already share a canonical', async () => {
    await aliasReq(
      { from_user_id: 'alias-noop-p', to_user_id: 'alias-noop-r' },
      { 'x-lyraflow-server-key': SERVER_KEY },
    )
    await aliasReq(
      { from_user_id: 'alias-noop-q', to_user_id: 'alias-noop-r' },
      { 'x-lyraflow-server-key': SERVER_KEY },
    )

    const res = await aliasReq(
      { from_user_id: 'alias-noop-p', to_user_id: 'alias-noop-q' },
      { 'x-lyraflow-server-key': SERVER_KEY },
    )
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'noop' })
  })

  // Would catch: the type/length validation guard (typeof/length checks on
  // from_user_id/to_user_id) being dropped or weakened — req.body is a
  // defined object here, so this does NOT exercise the `req.body ?? {}`
  // fallback below; that is a separate failure mode covered next.
  it('rejects a body missing to_user_id with 400, given a valid server key', async () => {
    const res = await aliasReq(
      { from_user_id: 'alias-bad' },
      { 'x-lyraflow-server-key': SERVER_KEY },
    )
    expect(res.statusCode).toBe(400)
  })

  // THE test for the `req.body ?? {}` fallback in routes.ts. A request with
  // no payload and no content-type leaves req.body undefined — indexing
  // into it directly throws, which the /v1/* error handler in app.ts (any
  // uncaught throw under /v1/*) converts to a 503, not the 400 a genuinely
  // malformed request here deserves. Would catch: removing `?? {}` (or
  // narrowing it to only some falsy cases). Confirmed empirically: with the
  // fallback removed, this specific case flips to 503; the previous test's
  // payload ({ from_user_id: 'alias-bad' }) is unaffected either way since
  // req.body is already a defined object there.
  it('rejects a bodyless request (no payload, no content-type) with 400, not 503', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/alias',
      headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_body' })
  })
})

/**
 * Mocked deps, same pattern as routes.test.ts's "logs a failing dead-letter
 * write" test: a fake bindings.bind() that always throws, so the failure
 * mode is deterministic instead of fighting real Postgres into that state.
 */
describe('POST /v1/identify (mocked deps): a failing binding write', () => {
  const project: Project = {
    id: 99,
    slug: 'mocked',
    retentionMonths: 24,
    monthlyEventQuota: 1_000_000,
    serverKeyHash: 'mocked-server-key-hash',
    disabledAt: null,
  }
  const projects = {
    byWriteKey: async (key: string) => (key === 'wk_mock' ? project : null),
    byServerKey: async () => null,
  } as unknown as IngestDeps['projects']
  const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool
  const okCh = { insert: async () => {} } as unknown as ClickHouseClient
  const throwingBindings = {
    bind: async () => {
      throw new Error('identity_bindings write failed: pg unreachable')
    },
    cacheSize: 0,
  } as unknown as IngestDeps['bindings']
  const fakeAliases = {
    alias: async () => 'noop' as const,
    canonicalFor: async (_p: number, id: string) => id,
  } as unknown as IngestDeps['aliases']

  // THE test for rule 1. Would catch: the try/catch around the binding write
  // being removed (or narrowed to not cover this throw), which would turn a
  // good, already-accepted event into a 5xx for the customer's site.
  it('still returns 202 and logs, rather than failing the request', async () => {
    const lines: string[] = []
    const mockedApp = Fastify({
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
    registerIngestRoutes(mockedApp, {
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
      bindings: throwingBindings,
      aliases: fakeAliases,
    })

    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { message_id: randomUUID(), anonymous_id: 'a-throws', user_id: 'u-throws' },
    })

    expect(res.statusCode).toBe(202)
    const logged = lines.join('')
    expect(logged).toContain('identity binding write failed')
    await mockedApp.close()
  })
})
