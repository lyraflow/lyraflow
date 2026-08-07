import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { DeletionStore } from './deletion-store.js'
import { SuppressionStore } from './suppression-store.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
// Resolved by the ClickHouse *server* itself, inside the test network — not
// this process's host-mapped localhost:5433. Same pattern as person.test.ts,
// resolve.test.ts and dictionaries.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG_A = 'privacy-routes-a'
const SLUG_B = 'privacy-routes-b'
const WRITE_KEY_A = 'wk_privacy_routes_a'
const SERVER_KEY_A = 'sk_privacy_routes_a'
const WRITE_KEY_B = 'wk_privacy_routes_b'
const SERVER_KEY_B = 'sk_privacy_routes_b'

// The literal maxAttempts app.ts passes to registerPrivacyRoutes today (Task
// 10 replaces it with the configured value) — the "failed" test below has to
// exhaust the SAME number the running app is actually gated on.
const MAX_ATTEMPTS = 5

let app: FastifyInstance
let projectA: number
let projectB: number

// A second, independent DeletionStore/SuppressionStore over the SAME pg pool
// the app itself uses — for driving a request into 'completed'/'failed'/
// 'in_progress' state directly. `complete()`/`fail()` are scoped by request
// id, so calling them here cannot collide with any other test or file even
// though `deletion_requests` is shared across the whole suite; `claim()` is
// deliberately never used here (see DeletionStore.claim's own docstring) —
// it reaches across every project in the table, and a leftover row from an
// unrelated crashed run would make a claim-driven test flaky in a way an
// id-scoped update cannot be.
const suppression = new SuppressionStore(pg)
const deletions = new DeletionStore(pg, suppression)

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

async function cleanup(): Promise<void> {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterAll — see deletion-store.test.ts's
  // identical reasoning: a run that died mid-suite would otherwise leave rows
  // from a previous attempt for this run to collide with. Project deletion
  // cascades to identity_bindings, person_aliases, suppressed_persons and
  // deletion_requests (every FK above is ON DELETE CASCADE), so this alone
  // is enough on the Postgres side.
  await cleanup()

  projectA = await makeProject(SLUG_A, 'Privacy Routes A', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'Privacy Routes B', WRITE_KEY_B, SERVER_KEY_B)

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
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.deps.buffer.flush()
  await app.close()
  await cleanup()
  await ch.command({
    query: `ALTER TABLE events DELETE WHERE project_id IN (${projectA}, ${projectB})`,
  })
  await pg.end()
  await ch.close()
})

// Flushes the ingest buffer synchronously after every identify() — the 202
// response can return before the row has actually landed in ClickHouse, and
// resolvePersonScope resolves identity from Postgres directly (immune to
// that lag) but a caller's later GET /v1/persons/:id would still race the
// buffer without this.
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

/**
 * Identifies `userId` WITH an anonymous/device id bound to it — the ordinary
 * browser-SDK shape, and deliberately not `identify()` with only `user_id`
 * (person.test.ts's own "server-side tracking" case, which writes NO
 * `identity_bindings` row at all). This route's existence check
 * (`scope.group.length === 1 && scope.devices.length === 0`) is
 * Postgres-only — unlike GET /v1/persons/:id, it never consults ClickHouse
 * — so a person with a real recorded event but no device binding of their
 * own would incorrectly 404 here despite GET finding them. See this file's
 * own report for that gap; every fixture below sidesteps it by giving each
 * identified person a device binding, which is the common case this route
 * is actually exercised against.
 */
async function identifyWithDevice(writeKey: string, userId: string) {
  return identify(writeKey, {
    message_id: randomUUID(),
    anonymous_id: `anon-${userId}`,
    user_id: userId,
  })
}

function aliasReq(serverKey: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/alias',
    headers: { 'x-lyraflow-server-key': serverKey, 'user-agent': UA },
    payload: body,
  })
}

function del(id: string, headers: Record<string, string>) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers: { 'user-agent': UA, ...headers },
  })
}

function deleteAs(id: string, serverKey: string) {
  return del(id, { 'x-lyraflow-server-key': serverKey })
}

function status(id: number | string, serverKey: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/deletions/${id}`,
    headers: { 'x-lyraflow-server-key': serverKey, 'user-agent': UA },
  })
}

function getPerson(id: string, serverKey: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers: { 'x-lyraflow-server-key': serverKey, 'user-agent': UA },
  })
}

describe('DELETE /v1/persons/:id', () => {
  it('rejects the write key', async () => {
    // The write key ships in browser JavaScript. A deletion endpoint
    // reachable with it is a public erase button.
    //
    // Sent under the SERVER-key header (not the write-key header) — the
    // same shape segments/routes.test.ts's own "requires the server key"
    // test uses. Sending it only under the write-key header would leave the
    // server-key header entirely absent, and the route would answer 401
    // `missing_server_key` regardless of whether the write-key check below
    // exists at all: that would still be 401, but for the wrong reason, and
    // would stay green against a route that happily accepted write keys
    // presented correctly. This shape specifically proves the write key is
    // rejected AS a server key, not merely that no server key was sent.
    const r = await deleteAs('irrelevant-id', WRITE_KEY_A)
    expect(r.statusCode).toBe(401)
    expect(r.json().error).toBe('invalid_server_key')
  })

  it('accepts a deletion and returns the boundary', async () => {
    const userId = `del-basic-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)

    const res = await deleteAs(userId, SERVER_KEY_A)
    expect(res.statusCode).toBe(202)
    const body = res.json()
    expect(typeof body.request_id).toBe('number')
    expect(body.person_id).toBe(userId)
    expect(typeof body.suppressed_at).toBe('string')
    // Within a generous window of "now" — this is a boundary just written by
    // this very request, not one anchored to a fixture date that ingest's
    // 24h clamp would otherwise reject.
    expect(Math.abs(Date.now() - new Date(body.suppressed_at).getTime())).toBeLessThan(60_000)
  })

  it('files the request against the CANONICAL person, not the requested id', async () => {
    // alias merged-id → canonical, then DELETE the merged id. Both rows must
    // name the canonical: suppressing a pre-alias id leaves the survivor
    // visible, the same defect class as an unresolved stage 2 in
    // resolvedPersonExpr.
    const fromId = `merge-from-${randomUUID()}`
    const toId = `merge-to-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, fromId)
    await identifyWithDevice(WRITE_KEY_A, toId)

    const aliasRes = await aliasReq(SERVER_KEY_A, { from_user_id: fromId, to_user_id: toId })
    expect(aliasRes.statusCode).toBe(200)

    const res = await deleteAs(fromId, SERVER_KEY_A)
    expect(res.statusCode).toBe(202)
    expect(res.json().person_id).toBe(toId)

    const sup = await pg.query(
      'SELECT person_id FROM suppressed_persons WHERE project_id = $1 AND person_id = $2',
      [projectA, toId],
    )
    expect(sup.rowCount).toBe(1)
    const supFrom = await pg.query(
      'SELECT person_id FROM suppressed_persons WHERE project_id = $1 AND person_id = $2',
      [projectA, fromId],
    )
    expect(supFrom.rowCount).toBe(0)

    const req = await pg.query('SELECT person_id FROM deletion_requests WHERE id = $1', [
      res.json().request_id,
    ])
    expect(req.rows[0]?.person_id).toBe(toId)
  })

  it('404s an id nothing in this project has recorded', async () => {
    const res = await deleteAs(`never-seen-${randomUUID()}`, SERVER_KEY_A)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('person_not_found')
  })

  it("does not accept a deletion for another project's person", async () => {
    // Same person id in two projects; delete under A; B's person read is
    // untouched and B has no request row.
    const sharedId = `cross-project-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, sharedId)
    await identifyWithDevice(WRITE_KEY_B, sharedId)

    const res = await deleteAs(sharedId, SERVER_KEY_A)
    expect(res.statusCode).toBe(202)

    const stillThere = await getPerson(sharedId, SERVER_KEY_B)
    expect(stillThere.statusCode).toBe(200)

    const supB = await pg.query(
      'SELECT 1 FROM suppressed_persons WHERE project_id = $1 AND person_id = $2',
      [projectB, sharedId],
    )
    expect(supB.rowCount).toBe(0)
    const reqB = await pg.query(
      'SELECT 1 FROM deletion_requests WHERE project_id = $1 AND person_id = $2',
      [projectB, sharedId],
    )
    expect(reqB.rowCount).toBe(0)
  })

  it('still returns 202 when the dictionary reload fails', async () => {
    // Point the route's ClickHouse client at a client whose command()
    // rejects. The rows are committed; the answer is 202 and the failure is
    // logged. Reporting 500 here would tell the caller to retry a deletion
    // that already happened.
    const userId = `reload-fails-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)

    const spy = vi
      .spyOn(ch, 'command')
      .mockRejectedValueOnce(new Error('deliberate reload failure injected for this test'))
    try {
      const res = await deleteAs(userId, SERVER_KEY_A)
      expect(res.statusCode).toBe(202)
      expect(res.json().person_id).toBe(userId)
    } finally {
      spy.mockRestore()
    }

    // The rows genuinely landed despite the reload failure.
    const sup = await pg.query(
      'SELECT 1 FROM suppressed_persons WHERE project_id = $1 AND person_id = $2',
      [projectA, userId],
    )
    expect(sup.rowCount).toBe(1)
  })
})

describe('GET /v1/deletions/:id', () => {
  it('reports pending, then completed', async () => {
    const userId = `status-lifecycle-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)
    const created = await deleteAs(userId, SERVER_KEY_A)
    const requestId = created.json().request_id as number

    const pending = await status(requestId, SERVER_KEY_A)
    expect(pending.statusCode).toBe(200)
    expect(pending.json().status).toBe('pending')
    expect(pending.json().completed_at).toBeNull()
    expect(typeof pending.json().requested_at).toBe('string')

    // Scoped by id — see the module-level `deletions` comment for why this
    // is safe against the shared `deletion_requests` table.
    await deletions.complete(requestId)

    const completed = await status(requestId, SERVER_KEY_A)
    expect(completed.statusCode).toBe(200)
    expect(completed.json().status).toBe('completed')
    expect(typeof completed.json().completed_at).toBe('string')
  })

  it('reports in_progress once claimed', async () => {
    const userId = `status-in-progress-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)
    const created = await deleteAs(userId, SERVER_KEY_A)
    const requestId = created.json().request_id as number

    // id-scoped, unlike DeletionStore.claim() — see the module comment.
    await pg.query('UPDATE deletion_requests SET claimed_at = now() WHERE id = $1', [requestId])

    const res = await status(requestId, SERVER_KEY_A)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('in_progress')
    expect(res.json().completed_at).toBeNull()
  })

  it('reports failed with the recorded error once attempts are exhausted', async () => {
    const userId = `status-failed-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)
    const created = await deleteAs(userId, SERVER_KEY_A)
    const requestId = created.json().request_id as number

    await pg.query('UPDATE deletion_requests SET attempts = $2 WHERE id = $1', [
      requestId,
      MAX_ATTEMPTS,
    ])
    await deletions.fail(requestId, 'deliberate failure for this test')

    const res = await status(requestId, SERVER_KEY_A)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('failed')
    expect(res.json().completed_at).toBeNull()
    expect(res.json().error).toBe('deliberate failure for this test')
  })

  it('404s a deletion request belonging to another project', async () => {
    const userId = `status-cross-project-${randomUUID()}`
    await identifyWithDevice(WRITE_KEY_A, userId)
    const created = await deleteAs(userId, SERVER_KEY_A)
    const requestId = created.json().request_id as number

    const res = await status(requestId, SERVER_KEY_B)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('deletion_not_found')
  })

  it('400s a malformed deletion id', async () => {
    const res = await status('not-a-number', SERVER_KEY_A)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_deletion_id')
  })

  it('404s an id nothing in this project has ever recorded', async () => {
    const res = await status(999_999_999, SERVER_KEY_A)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('deletion_not_found')
  })
})
