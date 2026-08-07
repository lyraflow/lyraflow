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
  // and never reloaded again below. This makes it *likely* the dictionary
  // stays unaware of ids this file binds later — LIFETIME(MIN 5 MAX 15)
  // refreshes on a background thread, and this file finishes in well under a
  // second — but "likely" is a timing assumption, not a guarantee: on a slow
  // CI host a refresh could land between an identify() and the read that
  // follows it. The dedicated "no dictionary reload" test below does not
  // rely on that assumption; it asserts the dictionary's actual answer via
  // dictGetOrDefault at the moment of the read, so it fails loudly instead of
  // silently passing if a refresh ever does land mid-test.
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

// Proves — rather than assumes from wall-clock timing — that the ClickHouse
// identity_bindings dictionary does not yet know about a device's binding at
// the moment of the read: queries the dictionary directly with a sentinel
// fallback no real person_id would ever equal, so getting the sentinel back
// means the dictionary has nothing for `anonymousId` (same
// dictGetOrDefault shape dictionaries.test.ts's own live probe uses).
async function dictionaryUnawareOf(projectId: number, anonymousId: string): Promise<boolean> {
  const sentinel = '__dict_bypass_probe_unbound__'
  const rs = await ch.query({
    query: `SELECT dictGetOrDefault('${CH_DB}.identity_bindings', 'person_id',
              (toUInt32(${projectId}), '${anonymousId}'), now(), '${sentinel}') AS person`,
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ person: string }>()
  return row?.person === sentinel
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
  // resolved canonical id instead of the full canonical-plus-devices set
  // (the pre-identify event was recorded under the *anonymous* id, never the
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
  //
  // The dictionaryUnawareOf() assertion below is the premise made explicit
  // and checked, not assumed from how fast this file happens to run: without
  // it, a background dictionary refresh landing between identify() and the
  // read (plausible on a slow CI host, since LIFETIME(MIN 5 MAX 15) is not
  // under this test's control) could silently make a dictGet-based
  // implementation pass anyway.
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

    // The premise this test's name claims, checked rather than assumed: at
    // this exact moment, the ClickHouse dictionary still has no answer for
    // 'lag-anon' — no SYSTEM RELOAD DICTIONARY call has run since beforeAll.
    expect(await dictionaryUnawareOf(projectA, 'lag-anon')).toBe(true)

    const personRes = await getPerson('lag-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    // 2: the pre-identify event, plus the identify() call's own event.
    expect(body.events).toBe(2)
    expect(body.ids.sort()).toEqual(['lag-anon', 'lag-user'])
  })

  // THE test for the alias-group defect: /v1/alias only ever writes to
  // person_aliases, never repoints identity_bindings.person_id — so a device
  // bound to an id *before* it gets merged away stays bound to that old id
  // in Postgres forever. The fixture binds the device to 'alias-a' — the id
  // that is about to be merged AWAY — and records a second event directly
  // under user_id 'alias-a', both *before* the merge. Binding the device to
  // the survivor 'alias-b' instead (as an earlier version of this test did)
  // would make a buggy personIdsFor(canonical)-only implementation
  // indistinguishable from a correct one: both would already find the
  // device via the canonical alone, with no need to ever consult
  // person_aliases for who merged into it. Would catch: PersonAliases'
  // mergedFrom() being dropped from person.ts (or never called), which
  // leaves 'alias-a' and 'alias-device' out of `ids` entirely and — since
  // 'alias-b' has no events of its own — turns this into a 404 instead of a
  // 200 with the full merged history. Would also catch: skipping
  // canonicalFor() and computing the group from the raw path id instead of
  // its canonical.
  it("resolves an aliased id's pre-merge devices and events into the surviving canonical's profile", async () => {
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'alias-device',
      user_id: 'alias-a',
      timestamp: '2026-08-06T10:00:00.000Z',
      traits: {},
    })
    await insertEvent({
      projectId: projectA,
      userId: 'alias-a',
      timestamp: '2026-08-06 10:30:00.000',
      eventName: 'alias_pre_merge_event',
    })

    const aliasRes = await aliasReq(SERVER_KEY_A, {
      from_user_id: 'alias-a',
      to_user_id: 'alias-b',
    })
    expect(aliasRes.statusCode).toBe(200)

    // Querying by the OLD id still resolves through canonicalFor to the
    // survivor's full merged profile.
    const byOldId = await getPerson('alias-a', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(byOldId.statusCode).toBe(200)
    const bodyByOldId = byOldId.json()
    expect(bodyByOldId.person_id).toBe('alias-b')
    expect(bodyByOldId.ids.sort()).toEqual(['alias-a', 'alias-b', 'alias-device'])
    // 2: the identify() call's own event (anonymous_id='alias-device',
    // user_id='alias-a'), plus the explicit alias_pre_merge_event recorded
    // directly under user_id='alias-a'.
    expect(bodyByOldId.events).toBe(2)
    expect(bodyByOldId.first_seen).toBe('2026-08-06T10:00:00.000Z')
    expect(bodyByOldId.last_seen).toBe('2026-08-06T10:30:00.000Z')

    // The reproduction from the review report: querying the SURVIVOR's own
    // id must return the identical, complete profile — not a 404, which is
    // exactly what 'alias-b' having no events of its own would previously
    // produce (personIdsFor(canonical) alone finds nothing bound to
    // 'alias-b').
    const bySurvivorId = await getPerson('alias-b', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(bySurvivorId.statusCode).toBe(200)
    expect(bySurvivorId.json()).toEqual(bodyByOldId)
  })

  // Would catch: sending `ids` straight from `[...group, ...devices]` without
  // deduping — identify({anonymous_id:'dup-id', user_id:'dup-id'}) makes
  // 'dup-id' both the canonical (via personId) and its own bound device, so
  // an undeduped implementation returns `['dup-id','dup-id']` here, which
  // fails the exact-array `toEqual` below (`.sort()` alone does not hide a
  // duplicate — `['dup-id','dup-id']` stays two elements after sorting).
  it('deduplicates ids when the anonymous_id and user_id coincide', async () => {
    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'dup-id',
      user_id: 'dup-id',
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const personRes = await getPerson('dup-id', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    expect(personRes.json().ids).toEqual(['dup-id'])
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
      devicesForAny: async () => [],
    } as unknown as PersonDeps['bindings']
    const fakeAliases = {
      canonicalFor: async (_p: number, id: string) => id,
      mergedFrom: async () => [],
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
