import { randomUUID } from 'node:crypto'
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

  // MEMBER_PAGE_SIZE real people matching `trait`, all with a real last_seen
  // (so all sort ahead of the far-future hand-built cursors below). Without
  // this, every members query in this file returns zero rows regardless of
  // whether a guard is even present — a mutant that deletes the
  // window-ceiling short-circuit would still pass, because there would be
  // nothing for the unguarded query to (wrongly) return. Exactly
  // MEMBER_PAGE_SIZE also lets one of the window-ceiling tests below observe
  // a genuinely FULL page landing on the ceiling, not just an empty one.
  await app.inject({
    method: 'POST',
    url: '/v1/batch',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': 'vitest' },
    payload: {
      batch: Array.from({ length: MEMBER_PAGE_SIZE }, (_, i) => ({
        type: 'identify',
        message_id: randomUUID(),
        user_id: `u-trial-${i}`,
        traits: { plan: 'trial' },
      })),
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
    // Pages of one walk must not claim different moments. Asserted with a
    // hand-built cursor rather than by paginating a small fixture: the
    // fixture may not fill a page, and `if (cursor) {...}` would then assert
    // nothing at all while still passing. The eviction case is the one that
    // matters — as_of recovered from the cache would survive a cache hit and
    // silently re-mint on a miss.
    const first = await preview({ ast_version: 1, filter: trait, include: ['members'] })
    const walkAsOf = first.json().as_of
    expect(typeof walkAsOf).toBe('string')

    const handmade = encodeCursor({
      lastSeen: '2099-01-01 00:00:00.000',
      personId: '',
      asOf: walkAsOf,
    })
    const second = await preview({
      ast_version: 1,
      filter: trait,
      include: ['members'],
      cursor: handmade,
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
    // hand-built wire cursor claiming the walk has already served the whole
    // page budget. A real walk reaches exactly this state after its last
    // allowed page; this jumps straight there rather than walking it.
    //
    // The wire format is routes.ts's private extension of the core cursor —
    // [lastSeen, personId, asOf, pagesServed] — built by hand here because
    // it is not exported; encodeCursor (core) has no page-count field to set.
    const pagesServedAtCeiling = MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE
    const atCeiling = Buffer.from(
      JSON.stringify(['2099-01-01 00:00:00.000', '', new Date().toISOString(), pagesServedAtCeiling]),
    ).toString('base64url')

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
    const oneShort = Buffer.from(
      JSON.stringify([
        '2099-01-01 00:00:00.000',
        '',
        new Date().toISOString(),
        MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE - 1,
      ]),
    ).toString('base64url')

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
})
