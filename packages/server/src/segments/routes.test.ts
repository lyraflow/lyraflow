import { createHmac, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MEMBER_PAGE_SIZE, MEMBER_WINDOW_MAX, encodeCursor } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const WRITE_KEY = 'wk_segments_routes'
const SERVER_KEY = 'sk_segments_routes'
const OTHER_SERVER_KEY = 'sk_segments_other'

let app: FastifyInstance
let otherProjectId: number

const trait = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }
// A second, much smaller cohort. Its purpose is a genuinely PARTIAL page:
// nonzero, under MEMBER_PAGE_SIZE, and nowhere near the window ceiling — the
// one shape the 'trial' cohort (sized to exactly MEMBER_PAGE_SIZE) never
// produces. `canOfferNext`'s "page was full" clause has no other way to be
// exercised, since a zero-row page short-circuits earlier (no `last` row to
// build a cursor from) and never reaches that clause at all.
const PARTIAL_PAGE_PEOPLE = 5
const enterpriseTrait = { kind: 'trait', key: 'plan', operator: '=', value: 'enterprise' }

const preview = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/segments/preview',
    headers: {
      'content-type': 'application/json',
      'x-lyraflow-server-key': SERVER_KEY,
      ...headers,
    },
    payload: body as never,
  })

/**
 * Mirrors routes.ts's cursorSigningKey/encodeWalkCursor exactly, so tests
 * below can hand-build a cursor this route accepts as genuinely its own —
 * needed to exercise the window ceiling without actually walking hundreds
 * of real pages. `hashServerKey(SERVER_KEY)` is the same value the server
 * itself resolves for this project via `project.serverKeyHash` (see
 * ProjectCache#byServerKey); nothing here reaches into the server's
 * internals, it recomputes what the server would compute from public
 * inputs (the label) and one value the server already keeps.
 *
 * Any drift from routes.ts's algorithm would make every hand-built cursor
 * below fail with 400 — a fast, loud failure mode, not a silently-wrong one.
 */
function signedWireCursor(
  lastSeen: string,
  personId: string,
  asOf: string,
  pagesServed: number,
): string {
  const key = createHmac('sha256', hashServerKey(SERVER_KEY))
    .update('lyraflow.segment-cursor.v1')
    .digest()
  const payload = JSON.stringify([lastSeen, personId, asOf, pagesServed])
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return Buffer.from(JSON.stringify([lastSeen, personId, asOf, pagesServed, signature])).toString(
    'base64url',
  )
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['segments-routes-test', 'segments-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Routes', 'segments-routes-test', $1, $2)`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Other', 'segments-routes-other', $1, $2) RETURNING id`,
    ['wk_segments_other', hashServerKey(OTHER_SERVER_KEY)],
  )
  otherProjectId = Number(other.rows[0]?.id)

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

  // Two cohorts, one batch call. `plan: 'trial'` is sized to exactly
  // MEMBER_PAGE_SIZE real people, all with a real last_seen (so all sort
  // ahead of the far-future hand-built cursors below). Without this, every
  // members query in this file returns zero rows regardless of whether a
  // guard is even present — a mutant that deletes the window-ceiling
  // short-circuit would still pass, because there would be nothing for the
  // unguarded query to (wrongly) return. Exactly MEMBER_PAGE_SIZE also lets
  // one of the window-ceiling tests below observe a genuinely FULL page
  // landing on the ceiling, not just an empty one.
  //
  // `plan: 'enterprise'` is the much smaller PARTIAL_PAGE_PEOPLE cohort — see
  // its comment above.
  await app.inject({
    method: 'POST',
    url: '/v1/batch',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': 'vitest' },
    payload: {
      batch: [
        ...Array.from({ length: MEMBER_PAGE_SIZE }, (_, i) => ({
          type: 'identify',
          message_id: randomUUID(),
          user_id: `u-trial-${i}`,
          traits: { plan: 'trial' },
        })),
        ...Array.from({ length: PARTIAL_PAGE_PEOPLE }, (_, i) => ({
          type: 'identify',
          message_id: randomUUID(),
          user_id: `u-enterprise-${i}`,
          traits: { plan: 'enterprise' },
        })),
      ],
    },
  })
  await app.deps.buffer.flush()
})

afterAll(async () => {
  await app.deps.buffer.flush()
  await app.close()
  for (const slug of ['segments-routes-test', 'segments-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  await pg.end()
  await ch.close()
})

describe('POST /v1/segments/preview', () => {
  /**
   * The write key must not open this route. Asserted by sending a VALID write
   * key in the server-key header, so the rejection is specifically "this key
   * is not a server key" — error `invalid_server_key`.
   *
   * Sending no server key at all would also return 401, but for the wrong
   * reason (`missing_server_key`), and would stay green against a route that
   * happily accepted write keys. Plan 2 shipped exactly that test once.
   */
  it('requires the server key, not the write key', async () => {
    const res = await preview(
      { ast_version: 1, filter: trait },
      { 'x-lyraflow-server-key': WRITE_KEY },
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_server_key')
  })

  it('returns a count and the cost warnings together', async () => {
    const res = await preview({
      ast_version: 1,
      filter: {
        kind: 'behavior',
        event: '*',
        aggregate: 'count',
        operator: '>=',
        value: 1,
        window: { kind: 'ever' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.person_count).toBe('number')
    expect(body.warnings).toHaveLength(2)
    // The spec requires results to carry the instant they describe, rather
    // than implying a freshness the system cannot deliver.
    expect(typeof body.as_of).toBe('string')
  })

  it('rejects a malformed tree with 400 and a field path', async () => {
    const res = await preview({ ast_version: 1, filter: { kind: 'trait' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeDefined()
  })

  it('rejects a tree past the caps with 400, not 500', async () => {
    let node: unknown = trait
    for (let i = 0; i < 12; i++) node = { kind: 'group', op: 'and', children: [node] }
    const res = await preview({ ast_version: 1, filter: node })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/nested|depth/i)
  })

  it('rejects an unknown ast_version rather than guessing', async () => {
    const res = await preview({ ast_version: 99, filter: trait })
    expect(res.statusCode).toBe(400)
  })

  it('cannot be pointed at another project', async () => {
    // There is no AST node for project_id and no request field for it; this
    // asserts that adding one to the payload changes nothing.
    const mine = await preview({ ast_version: 1, filter: trait })
    const spoofed = await preview({ ast_version: 1, filter: trait, project_id: otherProjectId })
    expect(mine.statusCode).toBe(200)
    expect(spoofed.json().person_count).toBe(mine.json().person_count)
  })

  it('returns members only when asked, and is unchanged otherwise', async () => {
    const without = await preview({ ast_version: 1, filter: trait })
    expect(without.json().members).toBeUndefined()

    const with_ = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    expect(with_.statusCode).toBe(200)
    expect(Array.isArray(with_.json().members)).toBe(true)
  })

  it('reports the same as_of for every page of one walk, even across a cache eviction', async () => {
    // Pages of one walk must not claim different moments. Continued with a
    // REAL next_cursor (the fixture seeds a full first page, so page 1
    // always offers one) rather than a hand-built one: this route now signs
    // its cursors, so only a cursor it minted itself is accepted at all —
    // see "rejects a cursor built with the public core encodeCursor" below.
    // The eviction case is still what matters here: page 2's cursor was
    // never cached before this call (a guaranteed miss), and as_of recovered
    // from the cache would survive a cache HIT and only re-mint on a miss —
    // this proves it does not, even on a guaranteed miss.
    const first = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    const walkAsOf = first.json().as_of
    expect(typeof walkAsOf).toBe('string')
    const cursor = first.json().next_cursor
    expect(typeof cursor).toBe('string')

    const second = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json().as_of).toBe(walkAsOf)
  })

  it('rejects a malformed cursor with 400', async () => {
    const res = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: 'not-a-cursor',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cursor/i)
  })

  it("rejects a cursor built with the public core encodeCursor, not this route's own signed one", async () => {
    // core's encodeCursor is exported and the brief sanctions its use for
    // building test cursors — but this route mints its own signed cursors
    // and must not treat a well-formed, UNSIGNED core cursor as one of its
    // own. Without this, a caller could read lastSeen/personId off any
    // response it already has and hand-roll an unbounded walk that never
    // trips the window ceiling.
    const bare = encodeCursor({
      lastSeen: '2099-01-01 00:00:00.000',
      personId: '',
      asOf: new Date().toISOString(),
    })
    const res = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: bare,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cursor/i)
  })

  it('rejects a legitimately-issued cursor that has been tampered with', async () => {
    // The exact forgery the signature exists to catch: take a cursor this
    // server actually issued, and change the field the window ceiling is
    // enforced against (pagesServed) without recomputing the signature —
    // the way a caller trying to defeat the ceiling would, having decoded
    // the wire format from the outside (it is base64url JSON, not opaque to
    // inspection) but not knowing the per-project signing key.
    const first = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    const real = first.json().next_cursor
    expect(typeof real).toBe('string')

    const decoded = JSON.parse(Buffer.from(real, 'base64url').toString('utf8'))
    decoded[3] = 0
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url')

    const res = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: tampered,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/cursor/i)
  })

  it('offers a next_cursor for a full page under budget', async () => {
    // Nothing before this asserted next_cursor is ever actually offered —
    // several tests receive a full page (the fixture seeds exactly
    // MEMBER_PAGE_SIZE matching people) but none checked next_cursor itself,
    // so a mutant that dropped the "page was full" clause from the
    // next_cursor decision entirely would have passed the whole suite.
    const res = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members).toHaveLength(MEMBER_PAGE_SIZE)
    expect(body.window_exhausted).toBe(false)
    expect(typeof body.next_cursor).toBe('string')
  })

  it('rejects an unknown include value rather than ignoring it', async () => {
    // Silently ignoring an unrecognised option is how a caller ends up
    // believing it asked for something it did not receive.
    const res = await preview({ ast_version: 1, filter: trait, include: ['everything'] })
    expect(res.statusCode).toBe(400)
  })

  it('returns an identical body on a cache hit', async () => {
    const a = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    const b = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    expect(b.json()).toEqual(a.json())
  })

  it('refuses to paginate past the window ceiling', async () => {
    // The fixture is far too small to walk a real MEMBER_WINDOW_MAX-row
    // window (it would take MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE real pages
    // to reach it), so this exercises the ceiling by construction: a
    // properly SIGNED wire cursor (see signedWireCursor above) claiming the
    // walk has already served the whole page budget. A real walk reaches
    // exactly this state after its last allowed page; this jumps straight
    // there rather than walking it. Signed, not hand-rolled unsigned JSON,
    // because this route now rejects anything it did not itself sign — an
    // unsigned version of this exact payload is covered by the malformed/
    // forged-cursor tests above, which assert 400, not 200.
    const pagesServedAtCeiling = MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE
    const atCeiling = signedWireCursor(
      '2099-01-01 00:00:00.000',
      '',
      new Date().toISOString(),
      pagesServedAtCeiling,
    )

    const res = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: atCeiling,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.window_exhausted).toBe(true)
    expect(body.next_cursor).toBeNull()
    expect(body.members).toEqual([])
  })

  it('flags window_exhausted on the page that spends the last of the budget, not only the page after', async () => {
    // Distinct from the test above: that one starts already PAST the ceiling
    // (pagesServed === the cap) and is refused before any query runs. This
    // one starts one page short of it (pagesServed === cap - 1), so the
    // query DOES run, and it is the resulting page — the one that spends the
    // last of the budget — that must carry the flag, not a follow-up empty
    // one. A mutant that only ever sets window_exhausted from the pre-query
    // short-circuit would pass the test above but fail this one.
    //
    // The fixture seeds exactly MEMBER_PAGE_SIZE matching people, all
    // sorting ahead of this far-future cursor, so this page comes back FULL
    // — which is what proves next_cursor is withheld BECAUSE of the ceiling
    // and not merely because the page happened to be partial. A mutant that
    // drops the "window has room" clause from the next_cursor decision (and
    // offers one on any full page, ceiling or not) fails only this
    // assertion, not the ones above.
    const oneShort = signedWireCursor(
      '2099-01-01 00:00:00.000',
      '',
      new Date().toISOString(),
      MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE - 1,
    )

    const res = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: oneShort,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members).toHaveLength(MEMBER_PAGE_SIZE)
    expect(body.window_exhausted).toBe(true)
    expect(body.next_cursor).toBeNull()
  })

  it('withholds next_cursor for a genuinely partial page, nowhere near the ceiling', async () => {
    // Distinct from "offers a next_cursor for a full page under budget":
    // that test's page is always exactly MEMBER_PAGE_SIZE, so removing the
    // "page was full" clause from canOfferNext changes nothing there — a
    // page of MEMBER_PAGE_SIZE members satisfies `=== MEMBER_PAGE_SIZE`
    // whether or not the clause is even checked, and the review that asked
    // for this test proved exactly that by deleting the clause and watching
    // the suite stay green. The `enterprise` cohort is small and nowhere
    // near MAX_MEMBER_PAGES, so this is a genuine "no more pages, and NOT
    // because the ceiling tripped" case — the one shape that DOES depend on
    // the clause.
    const res = await preview({ ast_version: 1, filter: enterpriseTrait, include: ['members'] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members.length).toBeGreaterThan(0)
    expect(body.members.length).toBeLessThan(MEMBER_PAGE_SIZE)
    expect(body.window_exhausted).toBe(false)
    expect(body.next_cursor).toBeNull()
  })
})

describe('/v1/segments CRUD and run', () => {
  const create = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/segments',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: body as never,
    })

  const runSaved = (id: number, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/segments/${id}/preview`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: body as never,
    })

  it('creates, reads, lists and deletes a segment', async () => {
    const created = await create({ name: 'Trial users', ast_version: 1, filter: trait })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    const read = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(read.json().filter).toEqual(trait)

    const list = await app.inject({
      method: 'GET',
      url: '/v1/segments',
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(list.json().segments.some((s: { id: number }) => s.id === id)).toBe(true)

    const gone = await app.inject({
      method: 'DELETE',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(gone.statusCode).toBe(204)
  })

  it('rejects a duplicate name with 409', async () => {
    await create({ name: 'Only once', ast_version: 1, filter: trait })
    const again = await create({ name: 'Only once', ast_version: 1, filter: trait })
    expect(again.statusCode).toBe(409)
  })

  it('returns 404 for a segment id that belongs to another project', async () => {
    // 404 rather than 403: a 403 confirms the id exists, which leaks the
    // shape of another tenant's data.
    const created = await create({ name: 'Private', ast_version: 1, filter: trait })
    const id = created.json().id
    const res = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': OTHER_SERVER_KEY },
    })
    expect(res.statusCode).toBe(404)
  })

  it('runs a saved segment and updates its snapshot', async () => {
    const created = await create({ name: 'Runnable', ast_version: 1, filter: trait })
    const id = created.json().id

    const before = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(before.json().last_count).toBeNull()

    const run = await runSaved(id)
    expect(run.statusCode).toBe(200)
    expect(typeof run.json().person_count).toBe('number')

    const after = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(after.json().last_count).toBe(run.json().person_count)
    expect(after.json().last_evaluated_at).not.toBeNull()
  })

  it('updates the snapshot when members are requested too', async () => {
    const created = await create({ name: 'Runnable with members', ast_version: 1, filter: trait })
    const id = created.json().id
    await runSaved(id, { include: ['members'] })
    const after = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(after.json().last_count).not.toBeNull()
  })

  it('clears the snapshot when a PATCH changes the filter, but not on a rename', async () => {
    const created = await create({ name: 'Editable', ast_version: 1, filter: trait })
    const id = created.json().id
    await runSaved(id)

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/segments/${id}`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { name: 'Editable (renamed)' } as never,
    })
    expect(renamed.json().last_count).not.toBeNull()

    const filterChanged = await app.inject({
      method: 'PATCH',
      url: `/v1/segments/${id}`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        ast_version: 1,
        filter: { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      } as never,
    })
    expect(filterChanged.statusCode).toBe(200)

    const after = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(after.json().last_count).toBeNull()
  })
})
