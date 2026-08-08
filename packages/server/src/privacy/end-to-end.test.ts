// The first test that walks a whole person through the real app: ingest,
// identify, more ingest, a person read, a segment count AND member page (both
// through the real POST /v1/segments/preview route — see previewSegment's own
// docstring for why the cache this goes through must be invalidated by
// DELETE for this to be safe), DELETE, the immediate post-DELETE view, an
// actual purge (driven by calling `runOnce()` directly — never by waiting on
// the worker's own timer, which would make this a test nobody runs), the raw
// stores afterward (with before/after snapshots where "the purge did not
// touch this" is the actual claim), and the status endpoint. The second test
// proves the whole point of time-scoped suppression: a person who returns
// after being erased is counted again, from the deletion forward, not
// blocked forever by their old identity.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { FilterNode } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'

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
 * segment checks below are built from.
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
 * Goes through the REAL `POST /v1/segments/preview` route, deliberately —
 * this is the one HTTP surface a caller actually has, and it is the one that
 * sits behind `SegmentCache`'s 30-second TTL (segments/cache.ts). That cache
 * is keyed only on the filter tree's own structural hash, with no dependency
 * on suppression state, which is exactly what made it possible to ask this
 * same route the identical question before and immediately after `DELETE`
 * and silently get back the pre-deletion answer — count AND the erased
 * person's own row, member fields included — instead of a fresh one. That
 * is now fixed at the source: `DELETE /v1/persons/:id` calls
 * `segmentCache.clearProject()` on the SAME cache instance this route reads
 * from (privacy/routes.ts, app.ts) before it answers `202`. Calling through
 * the route, not around it (an earlier version of this file called
 * `compileSegment`/`runSegment` directly to sidestep the cache instead of
 * fixing it — see Task 10's fix-round report for why that was wrong), is
 * what actually proves the fix rather than merely working around the bug it
 * exists to catch.
 */
function previewSegment(filter: FilterNode) {
  return app.inject({
    method: 'POST',
    url: '/v1/segments/preview',
    headers: {
      'x-lyraflow-server-key': SERVER_KEY,
      'user-agent': UA,
      'content-type': 'application/json',
    },
    payload: { ast_version: 1, filter, include: ['members'] },
  })
}

describe('privacy: a person, end to end from ingest to erasure', () => {
  const anonId = `e2e-anon-${randomUUID()}`
  const userId = `e2e-user-${randomUUID()}`
  const markerEvent = `e2e-marker-${randomUUID()}`
  let requestId: number

  it('deletes a person end to end', async () => {
    // 1. Ingest: anonymous events, an identify() carrying a trait, more
    // events. The trait is load-bearing for step 7 below: without it,
    // `person_traits` has zero rows for this person BEFORE the deletion too,
    // and "zero rows after the purge" would pass whether or not the purge
    // actually touches that table.
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
      traits: { plan: 'pro' },
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

    // The trait actually landed — the precondition step 7's "purged, not
    // never-written" assertion depends on.
    const traitsBefore = await ch.query({
      query: `SELECT count() AS c FROM person_traits
               WHERE project_id = {pid:UInt32} AND (user_id = {uid:String} OR anonymous_id = {aid:String})`,
      query_params: { pid: projectId, uid: userId, aid: anonId },
      format: 'JSONEachRow',
    })
    const [traitsBeforeRow] = await traitsBefore.json<{ c: string }>()
    expect(Number(traitsBeforeRow?.c ?? 0)).toBeGreaterThan(0)

    // 3. Segment preview → the person is counted, through the real HTTP
    // route, members page included — the row is the part that matters for
    // step 5 below.
    const before = await previewSegment(performedFilter(markerEvent))
    expect(before.statusCode).toBe(200)
    expect(before.json().person_count).toBe(1)
    const beforeMembers = before.json().members as Array<Record<string, unknown>>
    expect(beforeMembers).toHaveLength(1)
    expect(beforeMembers[0]?.person_id).toBe(userId)
    // The UA fixture parses to these exact values (core's parseUserAgent) —
    // asserting them, not just "a row exists", is what step 5 below needs to
    // meaningfully compare against: a cache bug returning a STALE row would
    // carry these same values, since they never change for this person.
    expect(beforeMembers[0]?.os).toBe('macos')
    expect(beforeMembers[0]?.browser).toBe('chrome')
    expect(beforeMembers[0]?.device_type).toBe('desktop')

    // 4. DELETE /v1/persons/:id → 202.
    const del = await deletePerson(userId)
    expect(del.statusCode).toBe(202)
    expect(del.json().person_id).toBe(userId)
    requestId = del.json().request_id as number

    // Snapshot suppression BEFORE the purge runs. Paired with the identical
    // query after runOnce() in step 7 below, this is what actually proves
    // the purge does not touch suppressed_persons — a single post-purge
    // assertion alone is consistent with either "never touched" or
    // "deleted and then, coincidentally, something else recreated it".
    const suppressedBefore = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM suppressed_persons WHERE project_id = $1 AND person_id = ANY($2)',
      [projectId, [userId, anonId]],
    )
    expect(suppressedBefore.rows.map((r) => r.person_id).sort()).toEqual([anonId, userId].sort())

    // 5. IMMEDIATELY: person read 404s, export 404s, segment count AND
    // member page both drop — through the SAME HTTP route and the SAME
    // filter tree as step 3, which is exactly the shape a stale
    // `SegmentCache` hit would otherwise defeat. No sleep, no reload beyond
    // the one DELETE's own handler already performs (the dictionary reload
    // and the cache invalidation, both in privacy/routes.ts).
    const readAfterDelete = await getPerson(userId)
    expect(readAfterDelete.statusCode).toBe(404)
    expect(readAfterDelete.json().error).toBe('person_not_found')

    const exportAfterDelete = await exportPerson(userId)
    expect(exportAfterDelete.statusCode).toBe(404)
    expect(exportAfterDelete.json().error).toBe('person_not_found')

    const after = await previewSegment(performedFilter(markerEvent))
    expect(after.statusCode).toBe(200)
    expect(after.json().person_count).toBe(0)
    expect(after.json().members).toEqual([])

    // 6. app.deps.purge.runOnce() — driven directly, never via the worker's
    // own timer (a test that sleeps for an interval is a test nobody runs).
    const outcome = await app.deps.purge.runOnce()
    expect(outcome).toBe('purged')

    // 7. Raw ClickHouse: zero rows in events, device_index and
    // person_traits (see the `traitsBefore` check above for why this is
    // meaningful and not vacuous). Raw Postgres: no identity_bindings; the
    // suppressed_persons rows REMAIN — compared against the `suppressedBefore`
    // snapshot, not merely asserted to exist in isolation (see
    // 005_suppression.sql).
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

    const suppressedAfter = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM suppressed_persons WHERE project_id = $1 AND person_id = ANY($2)',
      [projectId, [userId, anonId]],
    )
    expect(suppressedAfter.rows.map((r) => r.person_id).sort()).toEqual(
      suppressedBefore.rows.map((r) => r.person_id).sort(),
    )

    // 8. GET /v1/deletions/:id → status 'completed'.
    const status = await deletionStatus(requestId)
    expect(status.statusCode).toBe(200)
    expect(status.json().status).toBe('completed')
    expect(typeof status.json().completed_at).toBe('string')
  })

  // The whole argument for time-scoping: a person who returns after being
  // erased must be counted again, from the deletion forward — not treated
  // as permanently gone just because they once asked to be forgotten.
  //
  // COUPLED to the test above, deliberately: it reuses that test's `userId`
  // (whose identity_bindings/person_aliases the purge above deleted) and its
  // `markerEvent` (to prove the OLD history stays gone). This is safe only
  // because vitest runs one file's `it`s in declaration order by default —
  // there is no `test.concurrent` anywhere in this file — so `it.only` on
  // just this test, or reordering the two, would break it. Not made
  // independent on purpose: re-running the whole delete/purge sequence here
  // would just be the first test's own steps 1-6 copied, and would not
  // exercise anything this one is actually about.
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

    // The segment count (and member page) include them again for the NEW
    // activity, through the real route...
    const newPreview = await previewSegment(performedFilter(newMarker))
    expect(newPreview.statusCode).toBe(200)
    expect(newPreview.json().person_count).toBe(1)
    expect(
      (newPreview.json().members as Array<Record<string, unknown>>).map((m) => m.person_id),
    ).toEqual([userId])
    // ...but the OLD marker event stays gone forever — time-scoping allows
    // new history, it does not un-delete the old.
    const oldPreview = await previewSegment(performedFilter(markerEvent))
    expect(oldPreview.statusCode).toBe(200)
    expect(oldPreview.json().person_count).toBe(0)
  })
})
