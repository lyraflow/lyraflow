// The shape every other test in this package avoids: an identity mutation
// landing BETWEEN the `202` and the purge, and a purge that fails PART WAY
// THROUGH rather than not at all.
//
// Those two gaps are why four defects survived thirteen per-task reviews.
// `purge.test.ts`'s only alias fixture creates its merge BEFORE the deletion,
// so the id graph the purge re-resolves from is never one that changed after
// the request was accepted; `worker.test.ts` stubs `resolve` and `purge` out
// entirely, so the real resolution never runs against a real mutated graph at
// all. Everything below therefore goes through the REAL app, the REAL
// `resolvePersonScope`, and either the real `PurgeWorker` or one built over
// the same real `DeletionStore` — nothing here is stubbed except the single
// purge step that has to fail on cue.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { PersonAliases } from '../identity/aliases.js'
import { IdentityBindings } from '../identity/bindings.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  chunkWindows,
  personEventsPredicate,
  resolvePersonScope,
} from '../identity/scope.js'
import { DeletionStore } from './deletion-store.js'
import { SuppressionStore } from './suppression-store.js'
import { PurgeWorker } from './worker.js'

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
// pattern as every other live test file in this package.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG = 'privacy-postmut-a'
const WRITE_KEY = 'wk_privacy_postmut_a'
const SERVER_KEY = 'sk_privacy_postmut_a'

/** The configured defaults the app itself runs with — see config.ts. */
const MAX_ATTEMPTS = 5

let app: FastifyInstance
let projectId: number

const bindings = new IdentityBindings(pg)
const aliases = new PersonAliases(pg)
const suppression = new SuppressionStore(pg)
const deletions = new DeletionStore(pg, suppression)

/**
 * Anchored to the current run, not an absolute date — the ingest path clamps
 * a client timestamp older than 24h to now-24h (core's `clampTimestamp`), so
 * a hardcoded date would eventually put every fixture on the wrong side of
 * that clamp.
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000
const isoAt = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString()

/**
 * Run at the TOP of `beforeAll`, not only in `afterAll`: this file mutates
 * `events`, `device_index`, `person_traits`, `identity_bindings`,
 * `person_aliases`, `deletion_requests` and `suppressed_persons`, and has to
 * be safe run standalone three times in a row regardless of what a previous
 * crashed run left behind. The project id is looked up by slug rather than
 * read from a module variable, which is what makes it idempotent across runs
 * (Postgres ids are a fresh `serial` every time, so a crashed run's rows can
 * never be reached by an id this run happens to hold).
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    const list = ids.join(',')
    for (const table of ['events', 'device_index', 'person_traits']) {
      await ch.command({ query: `ALTER TABLE ${table} DELETE WHERE project_id IN (${list})` })
    }
  }
  // Cascades to identity_bindings, person_aliases, suppressed_persons and
  // deletion_requests on the Postgres side (every FK is ON DELETE CASCADE).
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

/**
 * `DeletionStore.claim()` is deliberately NOT project-scoped (see its own
 * docstring): it drains the whole queue across every project. A pending row
 * left behind by any earlier crashed run of ANY test file is therefore fair
 * game for every `runOnce()` below, and would be claimed ahead of this file's
 * own requests. Draining the table outright is what `worker.test.ts` does for
 * the same reason, and is only safe because `vitest.config.ts` sets
 * `fileParallelism: false`.
 */
async function drainQueue(): Promise<void> {
  await pg.query('DELETE FROM deletion_requests')
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()
  await drainQueue()

  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['Privacy Post-Request Mutation', SLUG, WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(r.rows[0]?.id)

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
  // buildApp deliberately does not start() the worker (app.ts) — this file
  // drives it through runOnce(), never through its own timer.
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
  // The 202 can return before the row lands in ClickHouse; every read below
  // needs it to have actually landed.
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

function aliasPersons(fromUserId: string, toUserId: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/alias',
    headers: { 'x-lyraflow-server-key': SERVER_KEY, 'user-agent': UA },
    payload: { from_user_id: fromUserId, to_user_id: toUserId },
  })
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
 * A full person: a device, an identify() carrying a trait (so `person_traits`
 * is non-empty and "zero rows afterwards" is a meaningful assertion rather
 * than a vacuous one), one anonymous event and one identified event.
 */
async function makePerson(userId: string, anonId: string, atMinute: number): Promise<void> {
  const anon = await track({
    message_id: randomUUID(),
    anonymous_id: anonId,
    type: 'track',
    event: 'postmut_anon_viewed',
    timestamp: isoAt(atMinute),
  })
  expect(anon.statusCode).toBe(202)

  const id = await identify({
    message_id: randomUUID(),
    anonymous_id: anonId,
    user_id: userId,
    type: 'identify',
    timestamp: isoAt(atMinute + 1),
    traits: { plan: 'pro' },
  })
  expect(id.statusCode).toBe(202)

  const identified = await track({
    message_id: randomUUID(),
    user_id: userId,
    type: 'track',
    event: 'postmut_identified_viewed',
    timestamp: isoAt(atMinute + 2),
  })
  expect(identified.statusCode).toBe(202)
}

/** Raw row count for one person's ids in a ClickHouse table. */
async function chCount(table: string, userId: string, anonId: string): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM ${table}
             WHERE project_id = {pid:UInt32}
               AND (user_id = {uid:String} OR anonymous_id = {aid:String})`,
    query_params: { pid: projectId, uid: userId, aid: anonId },
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ c: string }>()
  return Number(row?.c ?? -1)
}

/** Every ClickHouse-side footprint of one person, in one snapshot. */
async function storeSnapshot(userId: string, anonId: string) {
  return {
    events: await chCount('events', userId, anonId),
    deviceIndex: await chCount('device_index', userId, anonId),
    traits: await chCount('person_traits', userId, anonId),
  }
}

async function bindingCount(userId: string): Promise<number> {
  const r = await pg.query(
    'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND person_id = $2',
    [projectId, userId],
  )
  return r.rowCount ?? 0
}

async function suppressionCount(ids: string[]): Promise<number> {
  const r = await pg.query(
    'SELECT 1 FROM suppressed_persons WHERE project_id = $1 AND person_id = ANY($2)',
    [projectId, ids],
  )
  return r.rowCount ?? 0
}

/**
 * Drives the REAL worker until the named request completes. Bounded rather
 * than a `while (true)`: a fix that regresses should fail this as a timeout
 * with a clear count, not hang the suite.
 */
async function purgeUntilComplete(requestId: number): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const row = await deletions.get(projectId, requestId)
    if (row?.completedAt) return
    await app.deps.purge.runOnce()
  }
  const row = await deletions.get(projectId, requestId)
  expect(row?.completedAt, `request ${requestId} never completed: ${row?.lastError}`).not.toBeNull()
}

describe('finding 1: an /v1/alias between the 202 and the purge cannot widen the purge', () => {
  beforeAll(drainQueue)

  it('records the resolved id set on the request row', async () => {
    // The ceiling itself, asserted directly once: everything below depends on
    // this set actually reaching Postgres, and a silent regression to an
    // empty array would make every other test in this describe pass for the
    // wrong reason — empty means "unrestricted" (009_deletion_request_ids.sql).
    const userId = `postmut-ids-${randomUUID()}`
    const anonId = `anon-${userId}`
    await makePerson(userId, anonId, 0)

    const del = await deletePerson(userId)
    expect(del.statusCode).toBe(202)

    const row = await pg.query<{ person_ids: string[] }>(
      'SELECT person_ids FROM deletion_requests WHERE id = $1',
      [del.json().request_id],
    )
    expect(row.rows[0]?.person_ids.slice().sort()).toEqual([anonId, userId].sort())
  })

  it('leaves a live person untouched when the DELETED person is merged INTO them', async () => {
    // alice is deleted, then merged into bob. `canonicalFor(alice)` now
    // returns BOB, so an unrestricted re-resolution hands the purge bob's
    // entire group, devices and windows — and deletes all of it.
    const alice = `postmut-a-alice-${randomUUID()}`
    const aliceAnon = `anon-${alice}`
    const bob = `postmut-a-bob-${randomUUID()}`
    const bobAnon = `anon-${bob}`
    await makePerson(alice, aliceAnon, 10)
    await makePerson(bob, bobAnon, 20)

    const bobBefore = await storeSnapshot(bob, bobAnon)
    expect(bobBefore.events).toBeGreaterThan(0)
    expect(bobBefore.traits).toBeGreaterThan(0)
    expect(await bindingCount(bob)).toBeGreaterThan(0)

    const del = await deletePerson(alice)
    expect(del.statusCode).toBe(202)
    const requestId = del.json().request_id as number

    // The mutation, landing in the window between the 202 and the purge.
    const merged = await aliasPersons(alice, bob)
    expect(merged.statusCode).toBe(200)

    await purgeUntilComplete(requestId)

    // alice is genuinely gone — without this the assertions below would pass
    // for a purge that did nothing at all.
    const aliceAfter = await storeSnapshot(alice, aliceAnon)
    expect(aliceAfter.events).toBe(0)
    expect(await bindingCount(alice)).toBe(0)

    // bob is untouched, in every store the purge writes to.
    expect(await storeSnapshot(bob, bobAnon)).toEqual(bobBefore)
    expect(await bindingCount(bob)).toBeGreaterThan(0)
    // And nothing anywhere claims bob was erased — the absence of an audit
    // trail was the worst part of the original defect.
    expect(await suppressionCount([bob, bobAnon])).toBe(0)
  })

  it('leaves a live person untouched when THEY are merged INTO the deleted person', async () => {
    // The direction the cheap guard misses: `canonicalFor(dave)` is still
    // `dave` after this merge, so a `canonicalFor(personId) !== personId`
    // check sees nothing wrong — but `mergedFrom(dave)` now pulls carol's
    // ids into the group.
    const dave = `postmut-b-dave-${randomUUID()}`
    const daveAnon = `anon-${dave}`
    const carol = `postmut-b-carol-${randomUUID()}`
    const carolAnon = `anon-${carol}`
    await makePerson(dave, daveAnon, 30)
    await makePerson(carol, carolAnon, 40)

    const carolBefore = await storeSnapshot(carol, carolAnon)
    expect(carolBefore.events).toBeGreaterThan(0)
    expect(carolBefore.traits).toBeGreaterThan(0)

    const del = await deletePerson(dave)
    expect(del.statusCode).toBe(202)
    const requestId = del.json().request_id as number

    const merged = await aliasPersons(carol, dave)
    expect(merged.statusCode).toBe(200)

    await purgeUntilComplete(requestId)

    const daveAfter = await storeSnapshot(dave, daveAnon)
    expect(daveAfter.events).toBe(0)
    expect(await bindingCount(dave)).toBe(0)

    expect(await storeSnapshot(carol, carolAnon)).toEqual(carolBefore)
    expect(await bindingCount(carol)).toBeGreaterThan(0)
    expect(await suppressionCount([carol, carolAnon])).toBe(0)
  })

  it('still purges a device bound to the same person AFTER the request', async () => {
    // The other half of "narrow but never widen", and the reason the ceiling
    // is applied to the GROUP before devices are looked up rather than as a
    // filter over the finished scope: fresh resolution exists precisely so a
    // device bound between the 202 and the purge is still erased. Filtering
    // `devices` against the recorded set instead would drop exactly this
    // device — the test that would have caught that mistake.
    const erin = `postmut-c-erin-${randomUUID()}`
    const erinAnon = `anon-${erin}`
    const lateAnon = `anon-late-${randomUUID()}`
    await makePerson(erin, erinAnon, 50)

    const del = await deletePerson(erin)
    expect(del.statusCode).toBe(202)
    const requestId = del.json().request_id as number

    // A second device, bound to the SAME person after the request was
    // accepted, carrying an anonymous event of its own.
    const late = await track({
      message_id: randomUUID(),
      anonymous_id: lateAnon,
      type: 'track',
      event: 'postmut_late_viewed',
      timestamp: isoAt(56),
    })
    expect(late.statusCode).toBe(202)
    const boundLate = await identify({
      message_id: randomUUID(),
      anonymous_id: lateAnon,
      user_id: erin,
      type: 'identify',
      timestamp: isoAt(57),
    })
    expect(boundLate.statusCode).toBe(202)
    expect(await chCount('events', erin, lateAnon)).toBeGreaterThan(0)

    await purgeUntilComplete(requestId)

    // The late device's anonymous event is erased too, even though
    // `lateAnon` was not in the recorded id set.
    expect(await chCount('events', erin, lateAnon)).toBe(0)
    expect(await chCount('events', erin, erinAnon)).toBe(0)
  })
})

describe('findings 3 and 4: a purge that fails part way through', () => {
  const userId = `postmut-half-${randomUUID()}`
  const anonId = `anon-${userId}`
  let requestId: number

  beforeAll(async () => {
    await drainQueue()
    await makePerson(userId, anonId, 60)
  })

  /**
   * A worker that performs the purge's FIRST step for real and then throws —
   * the exact half-purged state finding 3 is about, and the one no existing
   * test produces (`worker.test.ts`'s failing purges never touch a store, so
   * they leave the person entirely intact).
   *
   * The event delete below is step 1 of `purgePerson` built from the SAME
   * `chunkWindows` / `personEventsPredicate` helpers that file uses, rather
   * than a hand-rolled predicate that could drift from it.
   */
  function halfPurgingWorker(): PurgeWorker {
    return new PurgeWorker({
      deletions,
      resolve: (pid, personId, restrictTo) =>
        resolvePersonScope({ bindings, aliases }, pid, personId, restrictTo),
      purge: async (pid: number, scope: PersonScope) => {
        for (const [i, chunk] of chunkWindows(scope.windows, MAX_PERSON_RANGE_CLAUSES).entries()) {
          const params: Record<string, unknown> = { projectId: pid }
          const identityPredicate = personEventsPredicate(
            { group: scope.group, windows: chunk },
            params,
            `c${i}_`,
          )
          await ch.command({
            query: `ALTER TABLE events DELETE WHERE project_id = {projectId:UInt32} AND ${identityPredicate}`,
            query_params: params,
            clickhouse_settings: { mutations_sync: '1' },
          })
        }
        throw new Error('ClickHouse: TOO_MANY_PARTS')
      },
      intervalMs: 60_000,
      leaseMs: 600_000,
      maxAttempts: MAX_ATTEMPTS,
      onError: () => {},
    })
  }

  it('reports pending WITH the error, not in_progress, while attempts remain', async () => {
    const del = await deletePerson(userId)
    expect(del.statusCode).toBe(202)
    requestId = del.json().request_id as number

    expect(await halfPurgingWorker().runOnce()).toBe('failed')

    // One attempt used, four left, and `fail()` deliberately leaves
    // `claimed_at` set so the retry waits out its backoff. The status
    // endpoint used to read that as "a worker has this in hand right now"
    // and answer `in_progress` — for ~50 minutes on the shipped defaults,
    // never once surfacing `last_error`, during exactly the interval an
    // operator is polling to find out what went wrong.
    const res = await deletionStatus(requestId)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('pending')
    expect(res.json().error).toBe('ClickHouse: TOO_MANY_PARTS')

    const row = await deletions.get(projectId, requestId)
    expect(row?.attempts).toBe(1)
    // The lease is still held — the fix must not have "solved" this by
    // clearing claimed_at, which would drop the retry backoff.
    expect(row?.claimedAt).not.toBeNull()
  })

  it('lets a fresh DELETE reopen the exhausted request instead of answering 404', async () => {
    // Burn the remaining attempts. Each one re-runs the (already complete)
    // event delete and throws again, which is exactly what a persistently
    // broken dependency produces.
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await pg.query('UPDATE deletion_requests SET claimed_at = NULL WHERE id = $1', [requestId])
      expect(await halfPurgingWorker().runOnce()).toBe('failed')
    }

    const dead = await deletions.get(projectId, requestId)
    expect(dead?.attempts).toBe(MAX_ATTEMPTS)
    expect((await deletionStatus(requestId)).json().status).toBe('failed')

    // The half-purged state: events gone, identity and traits still present.
    expect(await chCount('events', userId, anonId)).toBe(0)
    expect(await chCount('person_traits', userId, anonId)).toBeGreaterThan(0)
    expect(await bindingCount(userId)).toBeGreaterThan(0)

    // The subject is still in the stores and the worker will never touch
    // this request again. Before the fix every retry path answered
    // `404 person_not_found` — which reads as "already gone" — and there was
    // no API route back to a completed erasure.
    const retry = await deletePerson(userId)
    expect(retry.statusCode).toBe(202)
    // The ORIGINAL request, reopened — not a second one filed alongside it.
    expect(retry.json().request_id).toBe(requestId)
    expect(retry.json().person_id).toBe(userId)

    const reopened = await deletions.get(projectId, requestId)
    expect(reopened?.attempts).toBe(0)
    expect(reopened?.claimedAt).toBeNull()
    // The diagnosis survives the reopen; only `complete()` clears it.
    expect(reopened?.lastError).toBe('ClickHouse: TOO_MANY_PARTS')
    // Exactly one request for this person, still.
    const all = await pg.query('SELECT 1 FROM deletion_requests WHERE project_id = $1', [projectId])
    expect(all.rowCount).toBe(1)

    // And the recovery actually recovers: the real worker now finishes the
    // erasure it could not finish before.
    await purgeUntilComplete(requestId)
    expect(await chCount('person_traits', userId, anonId)).toBe(0)
    expect(await bindingCount(userId)).toBe(0)
    expect((await deletionStatus(requestId)).json().status).toBe('completed')
  })
})

describe('finding 2: a later merge must not un-delete a person', () => {
  beforeAll(drainQueue)

  it('keeps the person read and the export refusing after the merge', async () => {
    // alice is deleted at T1. bob then acts, and is deleted at T2 > T1. A
    // routine `/v1/alias` merging alice into bob puts alice's EARLIER
    // boundary into bob's group — and every Postgres-side consumer keeps
    // events with `timestamp > boundary`, so the earlier instant hides LESS.
    // Under `min` that merge handed bob's erased events straight back.
    const alice = `postmut-sup-alice-${randomUUID()}`
    const aliceAnon = `anon-${alice}`
    const bob = `postmut-sup-bob-${randomUUID()}`
    const bobAnon = `anon-${bob}`

    await makePerson(alice, aliceAnon, 70)

    const delAlice = await deletePerson(alice)
    expect(delAlice.statusCode).toBe(202)
    const t1 = new Date(delAlice.json().suppressed_at as string)

    // bob's whole history is created AFTER alice's boundary and BEFORE his
    // own — no explicit timestamps, so every event carries the server's
    // receipt instant and the ordering is real rather than asserted.
    await track({
      message_id: randomUUID(),
      anonymous_id: bobAnon,
      type: 'track',
      event: 'postmut_sup_anon',
    })
    await identify({
      message_id: randomUUID(),
      anonymous_id: bobAnon,
      user_id: bob,
      type: 'identify',
      traits: { plan: 'pro' },
    })
    await track({
      message_id: randomUUID(),
      user_id: bob,
      type: 'track',
      event: 'postmut_sup_identified',
    })

    const delBob = await deletePerson(bob)
    expect(delBob.statusCode).toBe(202)
    const t2 = new Date(delBob.json().suppressed_at as string)
    expect(t2.getTime()).toBeGreaterThan(t1.getTime())

    // Correct immediately after his own deletion, before any merge.
    expect((await getPerson(bob)).statusCode).toBe(404)
    expect((await exportPerson(bob)).statusCode).toBe(404)

    // The routine merge, with no relationship to either deletion.
    const merged = await aliasPersons(alice, bob)
    expect(merged.statusCode).toBe(200)

    // Still refused. Under `min(suppressed_at)` the read came back 200 with
    // `events: 1` and the export streamed the full event body back — the one
    // endpoint whose entire job is handing a subject their own data.
    const read = await getPerson(bob)
    expect(read.statusCode).toBe(404)
    expect(read.json().error).toBe('person_not_found')

    const exported = await exportPerson(bob)
    expect(exported.statusCode).toBe(404)
    expect(exported.json().error).toBe('person_not_found')
    // Asserted on the body too, not only the status: a 404 with a leaked
    // NDJSON body would still be a leak.
    expect(exported.body).not.toContain('postmut_sup_identified')

    // The boundary the group now resolves to is bob's own T2, not alice's
    // T1 — the derivation itself, not just its observable effect.
    const scope = await resolvePersonScope({ bindings, aliases }, projectId, bob)
    const boundary = await suppression.boundaryFor(projectId, scope.ids)
    expect(boundary?.getTime()).toBe(t2.getTime())
  })
})
