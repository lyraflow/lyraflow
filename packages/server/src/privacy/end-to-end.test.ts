// The first test that walks a whole person through the real app: ingest,
// identify, more ingest, a person read, a segment count, DELETE, the
// immediate post-DELETE view, an actual purge (driven by calling
// `runOnce()` directly — never by waiting on the worker's own timer, which
// would make this a test nobody runs), the raw stores afterward, and the
// status endpoint. The second test proves the whole point of time-scoped
// suppression: a person who returns after being erased is counted again,
// from the deletion forward, not blocked forever by their old identity.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type FilterNode, compileSegment } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { runSegment } from '../segments/execute.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
// Resolved by the ClickHouse *server* itself, inside the test network — same
// pattern as every other live test file in this package (routes.test.ts,
// export.test.ts, purge-restore.test.ts, worker.test.ts).
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG = 'privacy-e2e-a'
const WRITE_KEY = 'wk_privacy_e2e_a'
const SERVER_KEY = 'sk_privacy_e2e_a'

let app: FastifyInstance
let projectId: number

/**
 * Anchored to the current run, not to an absolute date — the ingest path
 * clamps a client timestamp older than 24h to now-24h (core's
 * `clampTimestamp`), so a hardcoded date would eventually put every fixture
 * on the wrong side of that clamp. Same reasoning as every other live test
 * file's own BASE_MS.
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000
const isoAt = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString()

async function makeProject(): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['Privacy End To End', SLUG, WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  return Number(r.rows[0]?.id)
}

/**
 * Run at the TOP of `beforeAll`, not only in `afterAll` — this file mutates
 * `events`, `device_index`, `person_traits`, `identity_bindings`,
 * `deletion_requests` and `suppressed_persons`, several of which other test
 * files in this package also touch, so it must be safe to run standalone,
 * three times in a row, regardless of what a previous crashed run left
 * behind. Looking the project id up by slug (rather than trusting a stale
 * module variable) is what makes that true even after a crash.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    const list = ids.join(',')
    await ch.command({ query: `ALTER TABLE events DELETE WHERE project_id IN (${list})` })
    await ch.command({ query: `ALTER TABLE device_index DELETE WHERE project_id IN (${list})` })
    await ch.command({ query: `ALTER TABLE person_traits DELETE WHERE project_id IN (${list})` })
  }
  // Cascades to identity_bindings, person_aliases, suppressed_persons and
  // deletion_requests on the Postgres side (every FK is ON DELETE CASCADE).
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()
  projectId = await makeProject()
  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

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
  // buildApp deliberately does not start() the worker (see app.ts) — this
  // file drives it itself, through runOnce(), never through its own timer.
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  app.deps.purge.stop()
  await app.deps.buffer.flush()
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

async function track(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/track',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': UA },
    payload: body,
  })
  // The 202 response can return before the row has actually landed in
  // ClickHouse — every read below (the person route, the export, the raw
  // store checks) needs it to have actually landed.
  await app.deps.buffer.flush()
  return res
}

async function identify(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/identify',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': UA },
    payload: body,
  })
  await app.deps.buffer.flush()
  return res
}

function getPerson(id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
  })
}

function exportPerson(id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}/export`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
  })
}

function deletePerson(id: string) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
  })
}

function deletionStatus(id: number) {
  return app.inject({
    method: 'GET',
    url: `/v1/deletions/${id}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
  })
}

/**
 * "Did this person perform `event` at all, ever" — the filter shape the
 * segment count below is built from.
 */
function performedFilter(event: string): FilterNode {
  return {
    kind: 'behavior',
    event,
    aggregate: 'count',
    operator: '>=',
    value: 1,
    window: { kind: 'ever' },
  }
}

/**
 * Counts people matching `filter`, through `compileSegment`/`runSegment` —
 * the exact production code POST /v1/segments/preview itself calls — rather
 * than through the HTTP route. Deliberately NOT the HTTP route: that route
 * sits behind `SegmentCache`'s 30-SECOND TTL, keyed on the filter tree's own
 * hash alone (segments/cache.ts) — with no dependency on suppression state,
 * so the identical filter tree used to prove "the person is counted" before
 * DELETE would still be a cache HIT immediately after it, silently
 * reporting the pre-deletion count instead of proving anything about
 * deletion at all. Calling the compiler directly is what this file's other
 * genuinely-live-database sibling, purge-restore.test.ts, already does for
 * the identical reason (see its own `visiblePersonIds`).
 */
async function segmentCount(filter: FilterNode): Promise<number> {
  const compiled = compileSegment({
    query: { ast_version: 1, filter } as never,
    projectId,
    database: CH_DB,
    now: new Date(),
    select: 'count',
  })
  return runSegment({ client: ch, compiled })
}

describe('privacy: a person, end to end from ingest to erasure', () => {
  const anonId = `e2e-anon-${randomUUID()}`
  const userId = `e2e-user-${randomUUID()}`
  const markerEvent = `e2e-marker-${randomUUID()}`
  let requestId: number

  it('deletes a person end to end', async () => {
    // 1. Ingest: anonymous events, an identify(), more events.
    const anon1 = await track({
      message_id: randomUUID(),
      anonymous_id: anonId,
      type: 'track',
      event: 'e2e_anon_viewed',
      timestamp: isoAt(0),
    })
    expect(anon1.statusCode).toBe(202)
    const anon2 = await track({
      message_id: randomUUID(),
      anonymous_id: anonId,
      type: 'track',
      event: markerEvent,
      timestamp: isoAt(5),
    })
    expect(anon2.statusCode).toBe(202)

    const idRes = await identify({
      message_id: randomUUID(),
      anonymous_id: anonId,
      user_id: userId,
      type: 'identify',
      timestamp: isoAt(10),
    })
    expect(idRes.statusCode).toBe(202)

    const idEvent = await track({
      message_id: randomUUID(),
      user_id: userId,
      type: 'track',
      event: 'e2e_identified_viewed',
      timestamp: isoAt(15),
    })
    expect(idEvent.statusCode).toBe(202)

    // 2. GET /v1/persons/:id → 200 with the full history: the two anonymous
    // events, the identify() event itself, and the one identified event.
    const read = await getPerson(userId)
    expect(read.statusCode).toBe(200)
    expect(read.json().events).toBe(4)
    expect((read.json().ids as string[]).sort()).toEqual([anonId, userId].sort())

    // 3. Segment preview → the person is counted.
    expect(await segmentCount(performedFilter(markerEvent))).toBe(1)

    // 4. DELETE /v1/persons/:id → 202.
    const del = await deletePerson(userId)
    expect(del.statusCode).toBe(202)
    expect(del.json().person_id).toBe(userId)
    requestId = del.json().request_id as number

    // 5. IMMEDIATELY: person read 404s, export 404s, segment count drops.
    // No sleep, no reload beyond the one DELETE's own handler already
    // performed (SYSTEM RELOAD DICTIONARY suppressed_persons).
    const readAfterDelete = await getPerson(userId)
    expect(readAfterDelete.statusCode).toBe(404)
    expect(readAfterDelete.json().error).toBe('person_not_found')

    const exportAfterDelete = await exportPerson(userId)
    expect(exportAfterDelete.statusCode).toBe(404)
    expect(exportAfterDelete.json().error).toBe('person_not_found')

    expect(await segmentCount(performedFilter(markerEvent))).toBe(0)

    // 6. app.deps.purge.runOnce() — driven directly, never via the worker's
    // own timer (a test that sleeps for an interval is a test nobody runs).
    const outcome = await app.deps.purge.runOnce()
    expect(outcome).toBe('purged')

    // 7. Raw ClickHouse: zero rows in events, device_index and
    // person_traits. Raw Postgres: no identity_bindings; the
    // suppressed_persons rows REMAIN (never deleted — see 005_suppression.sql).
    const identityFilter =
      'project_id = {pid:UInt32} AND (user_id = {uid:String} OR anonymous_id = {aid:String})'
    const params = { pid: projectId, uid: userId, aid: anonId }
    for (const table of ['events', 'device_index', 'person_traits']) {
      const rs = await ch.query({
        query: `SELECT count() AS c FROM ${table} WHERE ${identityFilter}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<{ c: string }>()
      expect(Number(row?.c ?? -1)).toBe(0)
    }

    const bindings = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND (person_id = $2 OR anonymous_id = $2)',
      [projectId, userId],
    )
    expect(bindings.rowCount).toBe(0)

    const suppressed = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM suppressed_persons WHERE project_id = $1 AND person_id = ANY($2)',
      [projectId, [userId, anonId]],
    )
    expect(suppressed.rows.map((r) => r.person_id).sort()).toEqual([anonId, userId].sort())

    // 8. GET /v1/deletions/:id → status 'completed'.
    const status = await deletionStatus(requestId)
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe('completed')
    expect(typeof status.json().completed_at).toBe('string')
  })

  // The whole argument for time-scoping: a person who returns after being
  // erased must be counted again, from the deletion forward — not treated
  // as permanently gone just because they once asked to be forgotten.
  it('a deleted person who returns is counted again, from the deletion forward', async () => {
    const newMarker = `e2e-marker-returned-${randomUUID()}`

    // Fresh activity for the SAME user id, after the purge above deleted
    // this person's identity_bindings/person_aliases entirely — this is a
    // brand new resolution, not a resumed one, the same shape a genuinely
    // returning customer produces. No explicit timestamp: defaults to the
    // server's receipt instant, which is unambiguously after the deletion
    // boundary set during the previous test.
    const res = await track({
      message_id: randomUUID(),
      user_id: userId,
      type: 'track',
      event: newMarker,
    })
    expect(res.statusCode).toBe(202)

    // The person reappears with ONLY the new history — the purged events
    // are gone, not merely hidden, so there is nothing else for the read to
    // find.
    const read = await getPerson(userId)
    expect(read.statusCode).toBe(200)
    expect(read.json().events).toBe(1)
    expect(read.json().ids).toEqual([userId])

    // The segment count includes them again for the NEW activity...
    expect(await segmentCount(performedFilter(newMarker))).toBe(1)
    // ...but the OLD marker event stays gone forever — time-scoping allows
    // new history, it does not un-delete the old.
    expect(await segmentCount(performedFilter(markerEvent))).toBe(0)
  })
})
