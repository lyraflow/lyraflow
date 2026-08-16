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
let projectId: number
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
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Routes', 'segments-routes-test', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
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

  // THE test for the segment cache actually being project-scoped, not merely
  // looking like it from the code. The existing cross-project test above
  // ("cannot be pointed at another project") runs both requests under the
  // SAME server key, so it cannot catch a cache key that dropped its
  // `${projectId}:` prefix — deleting that prefix from both countKey and
  // pageKey in routes.ts passes the entire rest of this suite untouched.
  // This one runs the identical tree under TWO DIFFERENT server keys: project
  // A has the seeded `trial` cohort, project B (OTHER_SERVER_KEY) has none of
  // it. A correctly scoped cache answers each from its own population; an
  // unscoped one lets B's request hit A's cached entry and come back with
  // A's count and A's member person ids.
  it('keeps the segment cache scoped per project, not shared across an identical tree', async () => {
    const a = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    expect(a.statusCode).toBe(200)
    expect(a.json().person_count).toBe(MEMBER_PAGE_SIZE)
    expect(a.json().members).toHaveLength(MEMBER_PAGE_SIZE)

    const b = await preview(
      { ast_version: 1, filter: trait, include: ['members'] },
      { 'x-lyraflow-server-key': OTHER_SERVER_KEY },
    )
    expect(b.statusCode).toBe(200)
    // Project B has none of project A's `plan: 'trial'` people. A leaked
    // cache hit would return A's count (MEMBER_PAGE_SIZE) and A's member
    // person ids here instead.
    expect(b.json().person_count).toBe(0)
    expect(b.json().members).toEqual([])
  })

  // THE test for the count cache's as_of, closing the gap the member path
  // already closed. Deliberately spaced by a real, controlled delay rather
  // than relying on two calls happening to land in the same millisecond: the
  // broken implementation re-mints `as_of` via `new Date().toISOString()`
  // on EVERY count-only call regardless of cache hit or miss, so without the
  // delay this assertion could pass against broken code purely by executing
  // fast enough. The delay makes the two timestamps provably different under
  // the broken code and provably identical under the fix, which does not
  // read the clock again on a hit at all.
  it('a cache hit returns the identical as_of as the miss that populated it', async () => {
    const countOnlyFilter = {
      kind: 'trait',
      key: 'plan',
      operator: '=',
      value: 'trial-asof-cache-test',
    }
    const miss = await preview({ ast_version: 1, filter: countOnlyFilter })
    expect(miss.statusCode).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const hit = await preview({ ast_version: 1, filter: countOnlyFilter })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().as_of).toBe(miss.json().as_of)
  })

  // Relative to Date.now(), not an absolute date: the ingest path clamps a
  // client timestamp older than 24h to `now − 24h` (see clampTimestamp), so a
  // hardcoded date would drift out of range and start failing on a wall-clock
  // schedule with no code change — exactly the failure this suite hit once
  // already.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

  const suppress = async (personId: string, at: Date) => {
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id, suppressed_at)
       VALUES ($1, $2, $3)`,
      [projectId, personId, at],
    )
    // The dictionary, not the table, is what the compiled query reads —
    // there is no deletion endpoint yet (Task 6) to do this reload for us.
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH.database}.suppressed_persons` })
  }

  it('hides a person whose whole history predates their deletion boundary', async () => {
    // Two people, identical behaviour. One is suppressed with a boundary
    // AFTER both of their events; the other is not.
    const suppressedUser = 'priv-scope-suppressed'
    const survivingUser = 'priv-scope-surviving'
    const cohort = { kind: 'trait', key: 'plan', operator: '=', value: 'privacy-scope-base' }

    await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': 'vitest' },
      payload: {
        batch: [
          {
            type: 'identify',
            message_id: randomUUID(),
            user_id: suppressedUser,
            traits: { plan: 'privacy-scope-base' },
            timestamp: hoursAgo(3),
          },
          {
            type: 'identify',
            message_id: randomUUID(),
            user_id: survivingUser,
            traits: { plan: 'privacy-scope-base' },
            timestamp: hoursAgo(3),
          },
        ],
      },
    })
    await app.deps.buffer.flush()

    // The boundary sits after both of the suppressed person's events, so
    // their entire history predates it.
    await suppress(suppressedUser, new Date(Date.now() - 1 * 3_600_000))

    const res = await preview({ ast_version: 1, filter: cohort, include: ['members'] })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Count drops by exactly one, out of the two identical people seeded.
    expect(body.person_count).toBe(1)
    const memberIds = (body.members as Array<{ person_id: string }>).map((m) => m.person_id)
    expect(memberIds).toContain(survivingUser)
    expect(memberIds).not.toContain(suppressedUser)
  })

  it('keeps a person who returned after the boundary, counting only later events', async () => {
    // One person: two events before the boundary, one after.
    const user = 'priv-scope-returned'
    const eventName = 'privacy_timescope_event'

    await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': 'vitest' },
      payload: {
        batch: [
          {
            type: 'track',
            message_id: randomUUID(),
            user_id: user,
            event: eventName,
            timestamp: hoursAgo(5),
          },
          {
            type: 'track',
            message_id: randomUUID(),
            user_id: user,
            event: eventName,
            timestamp: hoursAgo(4),
          },
          {
            type: 'track',
            message_id: randomUUID(),
            user_id: user,
            event: eventName,
            timestamp: hoursAgo(1),
          },
        ],
      },
    })
    await app.deps.buffer.flush()

    // Strictly between the two early events and the later one: two events
    // are erased, one survives.
    await suppress(user, new Date(Date.now() - 2 * 3_600_000))

    // A behavioural condition of "did X at least 3 times" must NOT match —
    // only one event survives the boundary. This is the test that
    // discriminates the per-event filter from a person-level one: a
    // person-level filter would still see all three events and match.
    const atLeastThree = await preview({
      ast_version: 1,
      filter: {
        kind: 'behavior',
        event: eventName,
        aggregate: 'count',
        operator: '>=',
        value: 3,
        window: { kind: 'ever' },
      },
    })
    expect(atLeastThree.statusCode).toBe(200)
    expect(atLeastThree.json().person_count).toBe(0)

    // "At least once" must match: the person themself survives the base
    // population filter (they have activity after their boundary), and the
    // one surviving event satisfies the behavioural condition.
    const atLeastOnce = await preview({
      ast_version: 1,
      filter: {
        kind: 'behavior',
        event: eventName,
        aggregate: 'count',
        operator: '>=',
        value: 1,
        window: { kind: 'ever' },
      },
    })
    expect(atLeastOnce.statusCode).toBe(200)
    expect(atLeastOnce.json().person_count).toBe(1)
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

  const runSaved = (id: number | string, body: unknown = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/segments/${id}/preview`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: body as never,
    })

  // Depth 12, one over MAX_TREE_DEPTH (10) — shape-valid (SegmentQuery.safeParse
  // accepts it fine) but cap-invalid, the exact gap between "stores" and "runs".
  let overCapFilter: unknown = trait
  for (let i = 0; i < 12; i++)
    overCapFilter = { kind: 'group', op: 'and', children: [overCapFilter] }

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

  /**
   * #21: the saved-segment run used to omit the cost warnings the ad-hoc
   * preview returns for the identical tree. Enumerates every warning kind
   * `costWarnings` can produce (see core/segments/validate.ts) rather than
   * just one, plus a tree that produces both at once — and for each,
   * compares the saved run's warnings against a preview of the SAME
   * definition, so a future divergence between the two entry points fails
   * here rather than passing quietly.
   */
  it('returns the same cost warnings a preview would, for every warning kind', async () => {
    const cases: { name: string; filter: unknown }[] = [
      {
        name: 'Ever window only',
        filter: {
          kind: 'behavior',
          event: 'signed_up',
          aggregate: 'count',
          operator: '>=',
          value: 1,
          window: { kind: 'ever' },
        },
      },
      {
        name: 'Wildcard event only',
        filter: {
          kind: 'behavior',
          event: '*',
          aggregate: 'count',
          operator: '>=',
          value: 1,
          window: { kind: 'last', n: 7, unit: 'days' },
        },
      },
      {
        name: 'Both ever window and wildcard event',
        filter: {
          kind: 'behavior',
          event: '*',
          aggregate: 'count',
          operator: '>=',
          value: 1,
          window: { kind: 'ever' },
        },
      },
    ]

    for (const { name, filter } of cases) {
      const created = await create({ name, ast_version: 1, filter })
      expect(created.statusCode).toBe(201)
      const id = created.json().id

      const savedRun = await runSaved(id)
      expect(savedRun.statusCode).toBe(200)

      const adHoc = await preview({ ast_version: 1, filter })
      expect(adHoc.statusCode).toBe(200)

      // Response shape is otherwise unchanged: person_count/as_of on the
      // saved run, warnings now present on both.
      expect(typeof savedRun.json().person_count).toBe('number')
      expect(Array.isArray(savedRun.json().warnings)).toBe(true)
      expect(savedRun.json().warnings.length).toBeGreaterThan(0)
      expect(savedRun.json().warnings).toEqual(adHoc.json().warnings)
    }
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

  it('rejects a non-numeric segment id with 400 on every :id route, not a 503', async () => {
    // Number('not-a-number') is NaN; without a guard this reaches Postgres as
    // a query parameter and trips the generic error handler into a 503 for a
    // deterministic client error — every :id route needs its own guard, so
    // this checks all four rather than trusting one to represent the rest.
    const badId = 'not-a-number'

    const get = await app.inject({
      method: 'GET',
      url: `/v1/segments/${badId}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(get.statusCode).toBe(400)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/segments/${badId}`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { name: 'whatever' } as never,
    })
    expect(patch.statusCode).toBe(400)

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/segments/${badId}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(del.statusCode).toBe(400)

    const run = await runSaved(badId)
    expect(run.statusCode).toBe(400)
  })

  // A bare `Number()` + `Number.isInteger()` check accepts all of these —
  // hex (`0x10`), a leading `+`, surrounding whitespace, and exponent
  // notation all coerce to a normal-looking finite integer. Each must be
  // rejected the same way `'not-a-number'` is above, matching the
  // `/^\d+$/`-first convention every `:id` route now shares via
  // `numeric-id.ts`'s `parseNumericId`. Zero passes that shape check —
  // it is `id > 0` that rejects it — and is pinned here so a local
  // parser reintroduced without that boundary would be caught.
  it.each([
    ['0x10', 'hex notation'],
    ['+5', 'a leading plus sign'],
    [' 1 ', 'surrounding whitespace'],
    ['1e3', 'exponent notation'],
    ['', 'an empty string'],
    ['-1', 'a negative number'],
    ['0', 'zero'],
    ['1.0', 'a decimal point'],
    ['99999999999999999999', 'a value beyond MAX_SAFE_INTEGER'],
  ])('rejects a segment id with %s (%s)', async (raw) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/segments/${encodeURIComponent(raw)}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_segment_id')
  })

  it('rejects an over-cap tree on create with 400', async () => {
    // Shape-valid, cap-invalid: without write-time validation this would
    // save with a 201 and then fail on every run thereafter.
    const res = await create({ name: 'Over cap on create', ast_version: 1, filter: overCapFilter })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an over-cap tree on update, leaving the stored row unchanged', async () => {
    const created = await create({ name: 'Valid then over-cap', ast_version: 1, filter: trait })
    const id = created.json().id

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/segments/${id}`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { ast_version: 1, filter: overCapFilter } as never,
    })
    expect(patch.statusCode).toBe(400)

    // Rejected before persistence, not just before the response: the row
    // still carries its original, valid filter rather than the rejected one.
    const after = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(after.json().filter).toEqual(trait)
  })

  // THE test for the finding this closes. `SegmentQuery.safeParse` is used
  // only to DETECT whether a tree was sent at all — without the fix, a body
  // that carries `filter`/`ast_version` but fails to parse is
  // indistinguishable from a rename-only body: `query.success` is false
  // either way, `store.update` is called with `query: undefined`, its
  // COALESCEs no-op, and the route answers 200 with the OLD filter silently
  // unchanged. POST /v1/segments already 400s for the identical malformed
  // body (see "rejects a malformed tree" on the preview route above, same
  // payload shape); PATCH must match, not silently discard it.
  it('rejects a malformed filter on PATCH with 400, not a silent no-op', async () => {
    const created = await create({
      name: 'Malformed patch is rejected, not dropped',
      ast_version: 1,
      filter: trait,
    })
    const id = created.json().id

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/segments/${id}`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { ast_version: 1, filter: { kind: 'trait' } } as never,
    })
    expect(patch.statusCode).toBe(400)
    expect(patch.json().error).toBeDefined()

    const after = await app.inject({
      method: 'GET',
      url: `/v1/segments/${id}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(after.json().filter).toEqual(trait)
  })

  // THE test for the finding this closes: list() must not let one unparseable
  // row take the other, perfectly fine segments in the project down with it.
  // Without the fix, list() throws StoredTreeError for the whole request and
  // GET /v1/segments answers 400 — hiding every OTHER segment in the project
  // along with the bad one.
  it('lists a project with one unparseable stored row, marking it rather than failing the list', async () => {
    const good = await create({ name: 'List: still readable', ast_version: 1, filter: trait })

    await pg.query(
      `INSERT INTO segments (project_id, name, ast_version, filter)
       VALUES ($1, 'List: unparseable stored row', 99, $2::jsonb)`,
      [projectId, JSON.stringify(trait)],
    )

    const list = await app.inject({
      method: 'GET',
      url: '/v1/segments',
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(list.statusCode).toBe(200)
    const segments = list.json().segments as Array<{
      id: number
      name: string
      filter: unknown
      stale: boolean
    }>

    const goodRow = segments.find((s) => s.id === good.json().id)
    expect(goodRow?.filter).toEqual(trait)
    expect(goodRow?.stale).toBe(false)

    const badRow = segments.find((s) => s.name === 'List: unparseable stored row')
    expect(badRow).toBeDefined()
    expect(badRow?.filter).toBeNull()
    expect(badRow?.stale).toBe(true)
  })
})
