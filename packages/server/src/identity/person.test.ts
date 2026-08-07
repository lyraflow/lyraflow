import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from './dictionaries.js'
import { type PersonDeps, registerPersonRoutes } from './person.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
// Resolved by the ClickHouse *server* itself, inside docker-compose.test.yml's
// own network — not this test process's host-mapped localhost:5433. Same
// pattern as resolve.test.ts and dictionaries.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

let app: FastifyInstance
let config: Config

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG_A = 'person-routes-test-a'
const SLUG_B = 'person-routes-test-b'
const WRITE_KEY_A = 'wk_person_routes_a'
const SERVER_KEY_A = 'sk_person_routes_a'
const WRITE_KEY_B = 'wk_person_routes_b'
const SERVER_KEY_B = 'sk_person_routes_b'

let projectA: number
let projectB: number

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  projectA = await makeProject(SLUG_A, 'PersonRoutesA', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'PersonRoutesB', WRITE_KEY_B, SERVER_KEY_B)

  // Created and loaded ONCE, before any of this file's own bindings exist,
  // and never reloaded again below. Every test that binds a new id via
  // /v1/identify and then reads it back is therefore implicitly proving the
  // read did not consult this (now permanently stale, for these ids)
  // dictionary — see the dedicated "no dictionary reload" test below for the
  // sharpest version of that claim.
  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })

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
  await pg.query('DELETE FROM identity_bindings WHERE project_id = ANY($1)', [[projectA, projectB]])
  await pg.query('DELETE FROM person_aliases WHERE project_id = ANY($1)', [[projectA, projectB]])
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
  // ClickHouse has no per-file DROP/CASCADE the way Postgres does — see the
  // identical comment and reasoning in resolve.test.ts's afterAll.
  await ch.command({
    query: `ALTER TABLE events DELETE WHERE project_id IN (${projectA}, ${projectB})`,
  })
  await pg.end()
  await ch.close()
})

// Flushes IngestBuffer synchronously after every identify(): buffer.add()
// triggers a flush fire-and-forget (`void this.#flushBatch()`, see
// buffer.ts) once flushRows is crossed, so the 202 response can return
// before the identify event's own row has actually landed in ClickHouse.
// Every test below reads that event set right back out, so without this the
// events count each test asserts on would be racy — same reasoning as
// routes.test.ts's per-request `await app.deps.buffer.flush()`.
async function identify(writeKey: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/identify',
    headers: { 'x-lyraflow-write-key': writeKey, 'user-agent': UA },
    payload: body,
  })
  await app.deps.buffer.flush()
  return res
}

function aliasReq(serverKey: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/alias',
    headers: { 'x-lyraflow-server-key': serverKey, 'user-agent': UA },
    payload: body,
  })
}

function getPerson(id: string, headers: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers,
  })
}

async function insertEvent(opts: {
  projectId: number
  anonymousId?: string
  userId?: string
  timestamp: string
  eventName: string
}): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: opts.projectId,
        event_id: randomUUID(),
        anonymous_id: opts.anonymousId ?? '',
        user_id: opts.userId ?? '',
        event_name: opts.eventName,
        timestamp: opts.timestamp,
        received_at: opts.timestamp,
        trusted: 0,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

describe('GET /v1/persons/:id', () => {
  // THE test for retroactive attachment — the product's premise (see the
  // task brief's "why this exists"). Would catch: querying only by the
  // resolved canonical id instead of the full personIdsFor() set (the
  // pre-identify event was recorded under the *anonymous* id, never the
  // user id); would catch dropping the `OR anonymous_id IN {ids}` half of
  // the WHERE clause entirely.
  it("includes an event sent under the person's anonymous_id before identify() was called", async () => {
    await insertEvent({
      projectId: projectA,
      anonymousId: 'retro-anon',
      timestamp: '2026-08-06 09:00:00.000',
      eventName: 'retro_pre_identify',
    })

    // The identify() call itself is also an event, recorded under this same
    // (anonymous_id, user_id) pair — given its own explicit, later timestamp
    // so first_seen/last_seen below are exact rather than racing wall-clock
    // `now`.
    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'retro-anon',
      user_id: 'retro-user',
      timestamp: '2026-08-06T09:30:00.000Z',
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const personRes = await getPerson('retro-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    expect(body.person_id).toBe('retro-user')
    expect(body.ids.sort()).toEqual(['retro-anon', 'retro-user'])
    // 2, not 1: the pre-identify event this test is actually about, plus the
    // identify() call's own event (see the comment above it).
    expect(body.events).toBe(2)
    expect(body.first_seen).toBe('2026-08-06T09:00:00.000Z')
    expect(body.last_seen).toBe('2026-08-06T09:30:00.000Z')
  })

  // THE test for zero dictionary lag — the entire reason this endpoint
  // exists. The identity dictionaries were built and loaded in beforeAll,
  // *before* 'lag-anon'/'lag-user' existed anywhere, and are never reloaded
  // anywhere in this file. A dictGetOrDefault-based implementation (the
  // pattern resolve.ts uses for segment-wide reads) would therefore still
  // resolve 'lag-anon' to itself — the binding this test creates is
  // invisible to that stale dictionary — and this event would be missing
  // from the response, or the person_id/ids would come back wrong. Reading
  // straight from IdentityBindings/PersonAliases (Postgres) sees the write
  // immediately, with nothing to reload.
  it('reflects a binding made moments ago, without any dictionary reload', async () => {
    await insertEvent({
      projectId: projectA,
      anonymousId: 'lag-anon',
      timestamp: '2026-08-06 10:00:00.000',
      eventName: 'lag_pre_identify',
    })

    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'lag-anon',
      user_id: 'lag-user',
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    // No SYSTEM RELOAD DICTIONARY call here or anywhere above — deliberately.
    const personRes = await getPerson('lag-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    // 2: the pre-identify event, plus the identify() call's own event.
    expect(body.events).toBe(2)
    expect(body.ids.sort()).toEqual(['lag-anon', 'lag-user'])
  })

  // Would catch: skipping the canonicalFor() step and calling
  // personIdsFor() with the raw path id instead of its canonical — 'alias-a'
  // has no device bindings of its own (only 'alias-b', the surviving
  // canonical, does), so that mutation would come back with ids: ['alias-a']
  // and events: 0 (a 404) instead of resolving through to 'alias-b'.
  it('resolves a request for an aliased id to the canonical person and its devices', async () => {
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'alias-device',
      user_id: 'alias-b',
      traits: {},
    })
    await insertEvent({
      projectId: projectA,
      anonymousId: 'alias-device',
      timestamp: '2026-08-06 11:00:00.000',
      eventName: 'alias_device_event',
    })

    const aliasRes = await aliasReq(SERVER_KEY_A, {
      from_user_id: 'alias-a',
      to_user_id: 'alias-b',
    })
    expect(aliasRes.statusCode).toBe(200)

    const personRes = await getPerson('alias-a', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    expect(body.person_id).toBe('alias-b')
    expect(body.ids.sort()).toEqual(['alias-b', 'alias-device'])
    // 2: the identify() call's own event, plus the explicit
    // alias_device_event inserted above.
    expect(body.events).toBe(2)
  })

  // Would catch: gating this route on projects.byWriteKey (or accepting
  // either header) instead of exclusively projects.byServerKey.
  it('rejects the public write key with 401', async () => {
    const res = await getPerson('anyone', { 'x-lyraflow-write-key': WRITE_KEY_A })
    expect(res.statusCode).toBe(401)
  })

  // Would catch: the "no header at all" branch answering something other
  // than 401 — e.g. falling through to an unauthenticated ClickHouse query.
  it('rejects a request with no key at all with 401', async () => {
    const res = await getPerson('anyone', {})
    expect(res.statusCode).toBe(401)
  })

  // The positive-path complement to the two 401 tests above: proves a valid
  // server key is actually accepted, not just that the wrong/missing key is
  // rejected. Would catch: authenticateServer built with the wrong lookup
  // (e.g. one that only ever returns null), which the two negative tests
  // alone cannot distinguish from "server key correctly rejected too".
  it('succeeds with a valid server key', async () => {
    await insertEvent({
      projectId: projectA,
      userId: 'server-key-ok',
      timestamp: '2026-08-06 12:00:00.000',
      eventName: 'server_key_ok_event',
    })
    const res = await getPerson('server-key-ok', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(res.statusCode).toBe(200)
  })

  // Documents the 404-vs-empty-result decision: an id nothing has ever
  // recorded is "no such person", not a person with a zeroed-out profile.
  // Would catch: always answering 200 regardless of whether any event
  // matched.
  it('answers 404 for an id with no known events, bindings, or aliases', async () => {
    const res = await getPerson('never-seen-anywhere', {
      'x-lyraflow-server-key': SERVER_KEY_A,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'person_not_found' })
  })

  // THE test for project scoping, and specifically for a dropped project_id
  // filter in the ClickHouse query. Both projects are given genuine,
  // non-empty data under the identical user_id 'shared-user' — a version of
  // this test where project B were empty would pass even with project_id
  // dropped entirely (project A's own rows would still be the only ones
  // found by accident). With real contention, dropping project_id would
  // instead return a merged/wrong first_seen, last_seen, and events count —
  // this test pins the exact expected values for project A alone.
  it("does not leak another project's events for the same user_id", async () => {
    await insertEvent({
      projectId: projectA,
      userId: 'shared-user',
      timestamp: '2026-08-06 13:00:00.000',
      eventName: 'scope_a_event',
    })
    await insertEvent({
      projectId: projectB,
      userId: 'shared-user',
      timestamp: '2026-01-01 00:00:00.000',
      eventName: 'scope_b_event_1',
    })
    await insertEvent({
      projectId: projectB,
      userId: 'shared-user',
      timestamp: '2026-01-02 00:00:00.000',
      eventName: 'scope_b_event_2',
    })

    const resA = await getPerson('shared-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(resA.statusCode).toBe(200)
    const bodyA = resA.json()
    expect(bodyA.events).toBe(1)
    expect(bodyA.first_seen).toBe('2026-08-06T13:00:00.000Z')
    expect(bodyA.last_seen).toBe('2026-08-06T13:00:00.000Z')

    const resB = await getPerson('shared-user', { 'x-lyraflow-server-key': SERVER_KEY_B })
    expect(resB.statusCode).toBe(200)
    const bodyB = resB.json()
    expect(bodyB.events).toBe(2)
    expect(bodyB.first_seen).toBe('2026-01-01T00:00:00.000Z')
    expect(bodyB.last_seen).toBe('2026-01-02T00:00:00.000Z')
  })
})

/**
 * Mocked deps for the SQL-injection-shaped-id case, same pattern as
 * identity-routes.test.ts's mocked-deps describe block: a fake ClickHouse
 * client whose `query()` records the exact query text and params it was
 * called with, so this test can assert the id never touches the SQL string
 * itself, without needing a live-service reproduction of an injection.
 */
describe('GET /v1/persons/:id (mocked ClickHouse): parameter binding', () => {
  // Would catch: building the WHERE clause by interpolating the path id
  // directly into the query string (e.g. template-literal-ing `ids` in)
  // instead of passing it through `query_params` — the captured query text
  // would then contain the raw dangerous id (and, on a real ClickHouse
  // server, the injected SQL would execute) rather than the `{ids:...}`
  // placeholder this test asserts on.
  it('passes the path id to ClickHouse as a bound parameter, never interpolated into the query text', async () => {
    const dangerousId = "x'); DROP TABLE events; --"
    let capturedQuery = ''
    let capturedParams: Record<string, unknown> = {}
    const fakeCh = {
      query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
        capturedQuery = opts.query
        capturedParams = opts.query_params ?? {}
        return {
          json: async () => [
            {
              first_seen: '2026-01-01 00:00:00.000',
              last_seen: '2026-01-01 00:00:00.000',
              events: '1',
            },
          ],
        }
      },
    } as unknown as ClickHouseClient
    const fakeProjects = {
      byServerKey: async (key: string) =>
        key === 'sk_fake'
          ? { id: 1, slug: 'fake', retentionMonths: 1, monthlyEventQuota: 1 }
          : null,
    } as unknown as PersonDeps['projects']
    const fakeBindings = {
      personIdsFor: async (_p: number, id: string) => [id],
    } as unknown as PersonDeps['bindings']
    const fakeAliases = {
      canonicalFor: async (_p: number, id: string) => id,
    } as unknown as PersonDeps['aliases']

    const mockedApp = Fastify()
    const readiness = new Readiness()
    readiness.markReady()
    registerPersonRoutes(mockedApp, {
      projects: fakeProjects,
      readiness,
      ch: fakeCh,
      bindings: fakeBindings,
      aliases: fakeAliases,
    })

    const res = await mockedApp.inject({
      method: 'GET',
      url: `/v1/persons/${encodeURIComponent(dangerousId)}`,
      headers: { 'x-lyraflow-server-key': 'sk_fake' },
    })

    expect(res.statusCode).toBe(200)
    expect(capturedQuery).not.toContain('DROP TABLE')
    expect(capturedQuery).toContain('{ids:Array(String)}')
    expect(capturedParams.ids).toEqual([dangerousId])
    await mockedApp.close()
  })
})
