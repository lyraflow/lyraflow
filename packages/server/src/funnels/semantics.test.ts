import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MEMBER_PAGE_SIZE } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'

/**
 * What a funnel MEANS, proved against a real ClickHouse.
 *
 * Every fixture here is seeded through the ingest API rather than by inserting
 * into `events` directly: a row written straight to the table skips the
 * enrichment and the identity writes a funnel depends on, so a test built that
 * way would pass against an engine that resolves nobody.
 */

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const WRITE_KEY = 'wk_funnel_semantics'
const SERVER_KEY = 'sk_funnel_semantics'

let app: FastifyInstance
let projectId: number

/**
 * EVERY FIXTURE LIVES INSIDE THE LAST 24 HOURS, because ingest clamps a client
 * timestamp to ±MAX_CLOCK_SKEW_MS of the server clock (see
 * core/src/ingest/timestamp.ts — device clocks are frequently wrong, and an
 * unclamped one poisons every time-windowed query).
 *
 * A fixture dated last June is therefore silently rewritten to `now - 24h`,
 * which collapses every event in this file to one instant and destroys the
 * ordering these tests exist to check. Discovered by writing it that way
 * first: the suite failed in six places that all looked like separate bugs.
 */
const HOUR = 3_600_000
const MINUTE = 60_000
const NOW = Date.now()
/** `ago(2 * HOUR)` — an ISO timestamp that far in the past. */
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const STEPS = [{ event: 'landed' }, { event: 'clicked' }, { event: 'converted' }]
/** One hour. Long enough for a multi-step journey, short enough to elapse. */
const WINDOW = 3600
/**
 * Ends twelve hours ago, so every entrant inside it has had its full window
 * many times over and nobody is a partial-window entrant by accident.
 */
const RANGE = { since: ago(23 * HOUR), until: ago(12 * HOUR) }

const track = (anonymousId: string, event: string, timestamp: string, props?: object) => ({
  type: 'track',
  message_id: randomUUID(),
  anonymous_id: anonymousId,
  event,
  timestamp,
  ...(props ? { properties: props } : {}),
})

async function send(batch: object[]): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/batch',
    headers: { 'x-lyraflow-write-key': WRITE_KEY, 'user-agent': 'vitest' },
    payload: { batch } as never,
  })
  if (res.statusCode !== 202 && res.statusCode !== 200) {
    throw new Error(`ingest failed: ${res.statusCode} ${res.body}`)
  }
  // Ingest is buffered: without this the rows are accepted but not yet in
  // ClickHouse, and every assertion below would read an empty table — passing
  // for any engine, including one that resolves nobody.
  await app.deps.buffer.flush()
}

const preview = async (body: object) => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/funnels/preview',
    headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
    payload: { steps: STEPS, window_seconds: WINDOW, ...RANGE, ...body } as never,
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

/**
 * A person's whole journey, one event per entry, spaced a minute apart
 * inside `RANGE`.
 *
 * Offsets are given FROM THE FIRST EVENT rather than absolutely, because
 * every optional-step question here is about order and distance, never about
 * a wall-clock instant. `send` flushes, so the rows are queryable when this
 * returns.
 *
 * `RANGE.since` is an ISO string (see `ago` above), not a `Date` -- wrapped
 * here rather than changed at the call site, since every other use in this
 * file passes it straight through as a string.
 */
async function journey(
  name: string,
  events: readonly (string | readonly [string, number])[],
): Promise<void> {
  const start = new Date(RANGE.since).getTime() + 60_000
  await send(
    events.map((e, i) => {
      const [event, offsetMs] = typeof e === 'string' ? [e, i * 60_000] : e
      return track(who(name), event, new Date(start + offsetMs).toISOString())
    }),
  )
}

/** Everyone in this file shares one project, so each case uses its own ids. */
const who = (name: string) => `sem-${name}`

/**
 * The identity dictionaries are ClickHouse-side caches with their own refresh
 * lifetime, so a binding written a moment ago is not yet visible to a query
 * that reads them. Every test that identifies someone and then asks a
 * question about them has to force the reload, or it silently measures the
 * pre-identify world — which looks exactly like an engine that cannot resolve
 * identity at all.
 */
/**
 * How the ClickHouse *server* reaches Postgres to populate the identity
 * dictionaries -- its own container network, not this process's host-mapped
 * `localhost:5433`. Same shape as `person.test.ts` and `resolve.test.ts`.
 */
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH.database,
}

async function reloadIdentityDictionaries(): Promise<void> {
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH.database}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH.database}.person_aliases` })
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // CREATE the identity dictionaries, not merely reload them.
  //
  // Every read in this file resolves a person through `identity_bindings`,
  // and `reloadIdentityDictionaries` below issues `SYSTEM RELOAD DICTIONARY`,
  // which requires one that already exists. This file never created them --
  // it inherited them from whichever other suite had run against the same
  // database first, and on a machine where the test database persists
  // between runs that is always true, so the gap was invisible.
  //
  // It is not true of a fresh database. CI creates one per run, so whether
  // this file passed depended on the order vitest happened to pick: land
  // before every suite that calls `ensureIdentityDictionaries` and all 34
  // tests here fail at once with "Dictionary not found" and a 503, including
  // the ones that predate this feature by months. Creating them here makes
  // this file independent of that order, which is what every other suite
  // needing them already does.
  await ensureIdentityDictionaries(ch, pgSource)
  await pg.query('DELETE FROM projects WHERE slug = $1', ['funnel-semantics'])
  const p = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Funnel Semantics', 'funnel-semantics', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(p.rows[0]?.id)

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
  await app.close()
  await ch.command({
    query: `ALTER TABLE events DELETE WHERE project_id = ${projectId}`,
  })
  // CREATE the identity dictionaries, not merely reload them.
  //
  // Every read in this file resolves a person through `identity_bindings`,
  // and `reloadIdentityDictionaries` below issues `SYSTEM RELOAD DICTIONARY`,
  // which requires one that already exists. This file never created them --
  // it inherited them from whichever other suite had run against the same
  // database first, and on a machine where the test database persists
  // between runs that is always true, so the gap was invisible.
  //
  // It is not true of a fresh database. CI creates one per run, so whether
  // this file passed depended on the order vitest happened to pick: land
  // before every suite that calls `ensureIdentityDictionaries` and all 34
  // tests here fail at once with "Dictionary not found" and a 503, including
  // the ones that predate this feature by months. Creating them here makes
  // this file independent of that order, which is what every other suite
  // needing them already does.
  await ensureIdentityDictionaries(ch, pgSource)
  await pg.query('DELETE FROM projects WHERE slug = $1', ['funnel-semantics'])
  await pg.end()
  await ch.close()
})

describe('funnel semantics', () => {
  it('counts someone who completes every step at the final level', async () => {
    const p = who('complete')
    await send([
      track(p, 'landed', ago(22 * HOUR)),
      track(p, 'clicked', ago(22 * HOUR - MINUTE)),
      track(p, 'converted', ago(22 * HOUR - 2 * MINUTE)),
    ])
    // THIS person at THIS level, not merely "somebody converted": the weaker
    // assertion passed against a stub returning a fixed plausible histogram.
    expect(await levelOf(p)).toBe(3)
  })

  it('counts the BEST attempt: abandon on day 1, complete on day 3', async () => {
    // The pin for the sliding window. An engine anchored on the first step-1
    // event would report this person as stuck at step 2 forever.
    const p = who('best-attempt')
    await send([
      track(p, 'landed', ago(22 * HOUR)),
      track(p, 'clicked', ago(22 * HOUR - MINUTE)),
      // Second attempt, eight hours later — far outside the one-hour window
      // of the first — and this one goes all the way through.
      track(p, 'landed', ago(14 * HOUR)),
      track(p, 'clicked', ago(14 * HOUR - MINUTE)),
      track(p, 'converted', ago(14 * HOUR - 2 * MINUTE)),
    ])
    // Level 3, not level 2: the day-3 run completes, and the sliding window
    // finds it even though the day-0 attempt died at step 2.
    expect(await levelOf(p)).toBe(3)
  })

  it('stops at step 2 when the window is too short, and converts when it is not', async () => {
    // The window is load-bearing: the same events, two windows, two answers.
    const p = who('short-window')
    await send([
      track(p, 'landed', ago(22 * HOUR)),
      track(p, 'clicked', ago(22 * HOUR - 30_000)),
      track(p, 'converted', ago(22 * HOUR - 30 * MINUTE)),
    ])
    expect(await levelOf(p, { window_seconds: 60 })).toBe(2)
    expect(await levelOf(p, { window_seconds: WINDOW })).toBe(3)
  })

  it('does not convert when the steps happen out of order', async () => {
    const p = who('out-of-order')
    await send([
      track(p, 'converted', ago(22 * HOUR)),
      track(p, 'clicked', ago(22 * HOUR - MINUTE)),
      track(p, 'landed', ago(22 * HOUR - 2 * MINUTE)),
    ])
    // `landed` is last, so the chain can only ever reach step 1.
    expect(await levelOf(p)).toBe(1)
  })

  it('is not broken by an unrelated event between two steps', async () => {
    const p = who('interleaved')
    await send([
      track(p, 'landed', ago(22 * HOUR)),
      track(p, 'noise', ago(22 * HOUR - 30_000)),
      track(p, 'clicked', ago(22 * HOUR - MINUTE)),
      track(p, 'noise', ago(22 * HOUR - 90_000)),
      track(p, 'converted', ago(22 * HOUR - 2 * MINUTE)),
    ])
    expect(await levelOf(p)).toBe(3)
  })

  it('counts a duplicate delivery of the same event once', async () => {
    const p = who('duplicate')
    const dup = track(p, 'landed', ago(22 * HOUR))
    await send([dup, { ...dup }, track(p, 'clicked', ago(22 * HOUR - MINUTE))])
    expect(await levelOf(p)).toBe(2)
  })

  it('converts when ingest order disagrees with timestamp order', async () => {
    // THE MUTATION THE REST OF THIS SUITE IS SHAPED TO AVOID. Every other
    // fixture here creates a person's events already in step order, because
    // that is how a test author thinks. A retrying SDK on a flaky connection
    // does not: a step-1 event can arrive after step 3 has already landed,
    // carrying an earlier timestamp. windowFunnel sorting internally is a
    // claim to verify, not to assume.
    const p = who('late-arrival')
    await send([track(p, 'converted', ago(22 * HOUR - 2 * MINUTE))])
    await send([track(p, 'clicked', ago(22 * HOUR - MINUTE))])
    await send([track(p, 'landed', ago(22 * HOUR))])
    expect(await levelOf(p)).toBe(3)
  })

  it('treats a person as one across an identify in the middle of the funnel', async () => {
    // The identity pin. Steps 1-2 anonymous, then /v1/identify, then step 3
    // as a known user — one person, entered once, converted.
    const anon = who('identity')
    const userId = 'sem-user-identity'
    await send([
      track(anon, 'landed', ago(22 * HOUR)),
      track(anon, 'clicked', ago(22 * HOUR - MINUTE)),
    ])
    await send([
      { type: 'identify', message_id: randomUUID(), anonymous_id: anon, user_id: userId },
    ])
    await reloadIdentityDictionaries()
    await send([
      {
        type: 'track',
        message_id: randomUUID(),
        user_id: userId,
        event: 'converted',
        timestamp: ago(22 * HOUR - 2 * MINUTE),
      },
    ])
    // The drop-off list keys by RESOLVED person, so this person appears under
    // whichever id the resolution canonicalises to — and at level 3, rather
    // than as two people stuck at levels 2 and 0.
    const atThree = await dropoffPeopleFor(3)
    const atTwo = await dropoffPeopleFor(2)
    expect(atThree.some((id) => id === anon || id === userId)).toBe(true)
    expect(atTwo.some((id) => id === anon || id === userId)).toBe(false)
  })

  it('reports partial-window entrants when the window has not elapsed', async () => {
    const p = who('partial')
    await send([track(p, 'landed', ago(MINUTE)), track(p, 'clicked', ago(MINUTE - 1000))])
    const r = await preview({
      since: ago(2 * HOUR),
      until: new Date().toISOString(),
      window_seconds: WINDOW,
    })
    expect(r.partial_window_entrants).toBeGreaterThanOrEqual(1)
    expect(r.warnings.some((w: { path: string }) => w.path === 'range')).toBe(true)

    // The same question over a range whose windows HAVE elapsed must answer
    // zero. Asserted here rather than as its own test so the pair is one
    // differential: a constant "nobody is partial" and a constant "everybody
    // is" each satisfy one half alone, and neither satisfies both.
    const elapsed = await preview({ steps: STEPS })
    expect(elapsed.partial_window_entrants).toBe(0)
    expect(elapsed.warnings.some((w: { path: string }) => w.path === 'range')).toBe(false)
  })

  it('excludes a deleted person from the counts and from the drop-off list', async () => {
    const p = who('deleted')
    const userId = 'sem-user-deleted'
    await send([track(p, 'landed', ago(22 * HOUR)), track(p, 'clicked', ago(22 * HOUR - MINUTE))])
    // Identified first, deliberately: an anonymous-only visitor cannot be
    // resolved, so DELETE answers 404 for one — the documented limitation in
    // the public tracker, not a funnel defect. Deleting requires a person the
    // API can name.
    await send([{ type: 'identify', message_id: randomUUID(), anonymous_id: p, user_id: userId }])
    await reloadIdentityDictionaries()
    // Keyed by RESOLVED person, so after the identify this person appears
    // under whichever id resolution canonicalises to — asserting on the
    // anonymous id alone would fail here for the right reason and be fixed
    // for the wrong one.
    const before = await dropoffPeopleFor(2)
    expect(before.some((id) => id === p || id === userId)).toBe(true)
    const countBefore = (await preview({ steps: STEPS })).steps[1].people

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/persons/${encodeURIComponent(userId)}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect([200, 202]).toContain(del.statusCode)

    // Two assertions, because they are two code paths: the histogram the
    // counts come from, and the drop-off list.
    const after = await dropoffPeopleFor(2)
    expect(after.some((id) => id === p || id === userId)).toBe(false)
    // Exactly one person fewer reached step 2 — not "at level 2", which is a
    // different population (see levels.ts).
    const countAfter = (await preview({ steps: STEPS })).steps[1].people
    expect(countAfter).toBe(countBefore - 1)
  })

  it('ACTUALLY restricts the population to a segment, not merely runs with one', async () => {
    // The whole-branch gap this closes: the existing route test asserts a
    // restricted funnel returns 200 and warns about nothing. Deleting the
    // segment SQL from the compile call entirely would still pass it — the
    // restriction would silently become a no-op and every "for paid users"
    // funnel would quietly report everyone.
    const inside = 'sem-seg-inside'
    const outside = 'sem-seg-outside'
    for (const [anon, plan] of [
      [inside, 'enterprise'],
      [outside, 'free'],
    ] as const) {
      await send([
        {
          type: 'identify',
          message_id: randomUUID(),
          anonymous_id: anon,
          user_id: anon,
          traits: { plan },
        },
        track(anon, 'landed', ago(21 * HOUR)),
        track(anon, 'clicked', ago(21 * HOUR - MINUTE)),
        track(anon, 'converted', ago(21 * HOUR - 2 * MINUTE)),
      ])
    }
    await reloadIdentityDictionaries()

    const seg = await pg.query<{ id: string }>(
      `INSERT INTO segments (project_id, name, filter, ast_version)
       VALUES ($1, $2, '{"kind":"trait","key":"plan","operator":"=","value":"enterprise"}'::jsonb, 1)
       RETURNING id`,
      [projectId, `enterprise-${randomUUID()}`],
    )

    const unrestricted = await preview({ steps: STEPS, until: new Date().toISOString() })
    const restricted = await preview({
      steps: STEPS,
      segment_id: Number(seg.rows[0]?.id),
      until: new Date().toISOString(),
    })

    // Both people converted, so an unrestricted run sees at least two and the
    // restricted one must see strictly fewer — and must still see somebody,
    // or a restriction that matched nobody would pass just as well.
    expect(unrestricted.converted).toBeGreaterThanOrEqual(2)
    expect(restricted.converted).toBeGreaterThanOrEqual(1)
    expect(restricted.converted).toBeLessThan(unrestricted.converted)
    await pg.query('DELETE FROM segments WHERE id = $1', [Number(seg.rows[0]?.id)])
  })

  it('pages drop-offs without repeating or skipping anyone', async () => {
    // MORE THAN ONE PAGE, deliberately. The first version of this test seeded
    // five people, never filled a page, and so never requested a second one —
    // it asserted "no duplicates in a single page", which any implementation
    // satisfies. A wrong keyset looks perfect until a population crosses
    // MEMBER_PAGE_SIZE, and that is the first real one, not a test one.
    const people = MEMBER_PAGE_SIZE + 5
    const batch: object[] = []
    for (let i = 0; i < people; i++) {
      const anon = `sem-page-${i}`
      // EVERY ENTRANT SHARES ONE INSTANT, deliberately. Spacing them a second
      // apart — the obvious way to write this — gives every row a distinct
      // `entered_at`, which is precisely the shape that hides a keyset
      // collapsed to `entered_at <` alone: with no ties, the tie-breaker is
      // never consulted and the bug is invisible. Verified by mutation: the
      // spaced version passed against exactly that defect.
      batch.push(
        track(anon, 'landed', ago(20 * HOUR)),
        track(anon, 'clicked', ago(20 * HOUR - 500)),
      )
    }
    // Batches are capped at 500 payloads, so this goes in chunks.
    for (let i = 0; i < batch.length; i += 400) await send(batch.slice(i, i + 400))
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { name: `paged-${randomUUID()}`, steps: STEPS, window_seconds: WINDOW } as never,
    })
    const id = created.json().id

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const res: { json: () => { people: { person_id: string }[]; next_cursor: string | null } } =
        await app.inject({
          method: 'POST',
          url: `/v1/funnels/${id}/dropoff`,
          headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
          payload: {
            step: 2,
            since: RANGE.since,
            until: new Date().toISOString(),
            ...(cursor ? { cursor } : {}),
          } as never,
        })
      const body = res.json()
      seen.push(...body.people.map((r) => r.person_id))
      cursor = body.next_cursor
      if (!cursor) break
    }
    // Nobody twice — a keyset using `<` alone rather than the lexicographic
    // pair would drop everyone sharing the boundary instant, and one built on
    // an offset would repeat under concurrent ingest.
    expect(new Set(seen).size).toBe(seen.length)
    for (let i = 0; i < people; i++) expect(seen).toContain(`sem-page-${i}`)
    // And it genuinely paged, rather than fitting in one response.
    expect(seen.length).toBeGreaterThan(MEMBER_PAGE_SIZE)
  })

  it('refuses a cursor minted for a different route', async () => {
    // The drop-off codec has its own label, so a segment walk cursor is not
    // replayable here even within one project.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { name: `forged-${randomUUID()}`, steps: STEPS, window_seconds: WINDOW } as never,
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${created.json().id}/dropoff`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        step: 1,
        cursor: Buffer.from('["a","b","c",0,"sig"]').toString('base64url'),
      } as never,
    })
    expect(res.statusCode).toBe(400)
  })

  it("leaves /dropoff's row shape unchanged now that /people shares its compile path", async () => {
    // Task 3's whole risk: `/people`'s `select: 'members'` joins `base` and
    // `traits`, and `/dropoff` now runs through the very same `compileFor`.
    // A row from `/dropoff` must still be the bare (person_id, entered_at)
    // pair it always was -- no traits key, however it got there.
    const p = who('dropoff-shape')
    await send([track(p, 'landed', ago(20 * HOUR))])
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: `dropoff-shape-${randomUUID()}`,
        steps: STEPS,
        window_seconds: WINDOW,
      } as never,
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${created.json().id}/dropoff`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { step: 1, since: RANGE.since, until: new Date().toISOString() } as never,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(
      ['as_of', 'next_cursor', 'people', 'range', 'step', 'window_exhausted'].sort(),
    )
    const row = body.people.find((r: { person_id: string }) => r.person_id === p)
    expect(row).toBeDefined()
    expect(Object.keys(row).sort()).toEqual(['entered_at', 'person_id'])
  })

  it("computes /people's person_count fresh within a SINGLE request, never from the funnel run's cached steps[i].people", async () => {
    // MemberList's own comment: comparing a stale count against a page
    // length is exactly how "that is everyone" gets printed over a
    // truncated preview. This proves it by changing the population AFTER
    // caching a run and confirming /people sees the change -- a route that
    // took its count from that cached run would still report the old
    // number.
    const first = who('count-fresh-a')
    await send([
      track(first, 'landed', ago(20 * HOUR)),
      track(first, 'clicked', ago(20 * HOUR - MINUTE)),
    ])
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: `count-fresh-${randomUUID()}`,
        steps: STEPS,
        window_seconds: WINDOW,
      } as never,
    })
    const id = created.json().id

    const ran = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${id}/run`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { since: RANGE.since, until: new Date().toISOString() } as never,
    })
    expect(ran.statusCode).toBe(200)
    const stale = ran.json().steps[1].people

    const second = who('count-fresh-b')
    await send([
      track(second, 'landed', ago(19 * HOUR)),
      track(second, 'clicked', ago(19 * HOUR - MINUTE)),
    ])

    const res = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${id}/people`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        step: 2,
        mode: 'reached',
        since: RANGE.since,
        until: new Date().toISOString(),
      } as never,
    })
    expect(res.statusCode).toBe(200)
    // The run cached ONE person at step 2; the second person landed after
    // that run, so a fresh count must see two -- a count reusing the
    // cached run would still report `stale`.
    expect(res.json().person_count).toBe(stale + 1)
  })

  it('reports person_count for the WHOLE population, not the page length -- proved by a population past MEMBER_PAGE_SIZE', async () => {
    // A DIFFERENT way `person_count` could be wrong: deriving it from
    // `members.length` rather than a real count query passes every other
    // test in this file, because every other fixture's population fits on
    // one page. Own step names, isolated from every other fixture in this
    // file sharing the plain `landed`/`clicked`/`converted` events.
    const landed = `count-page-landed-${randomUUID()}`
    const clicked = `count-page-clicked-${randomUUID()}`
    const people = MEMBER_PAGE_SIZE + 5
    const batch: object[] = []
    for (let i = 0; i < people; i++) {
      const anon = `sem-count-page-${i}`
      batch.push(track(anon, landed, ago(18 * HOUR)), track(anon, clicked, ago(18 * HOUR - 500)))
    }
    for (let i = 0; i < batch.length; i += 400) await send(batch.slice(i, i + 400))

    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: `count-page-${randomUUID()}`,
        steps: [{ event: landed }, { event: clicked }],
        window_seconds: WINDOW,
      } as never,
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${created.json().id}/people`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        step: 2,
        mode: 'reached',
        since: RANGE.since,
        until: new Date().toISOString(),
      } as never,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.members).toHaveLength(MEMBER_PAGE_SIZE)
    // The page is capped; the count must not be.
    expect(body.person_count).toBe(people)
  })

  it("keeps /people's person_count identical across the pages of one cursor walk, even when a person's second qualifying event lands between the two requests", async () => {
    // The gap the single-request test above cannot see: entry is gated by
    // `until`, fixed identically on both requests below, so a fixture that
    // only varies WHO ENTERS never exercises whether the count query
    // actually reuses the cursor's pinned `asOf` on page 2 rather than a
    // fresh `now()` -- both give the same answer when nothing about
    // CONTINUATION changes between requests (compile.ts:140-152, 204-206).
    // This fixture changes continuation instead: one extra person reaches
    // level 1 before page 1, then reaches level 2 in the gap between the
    // two requests, with a real wall-clock timestamp. A count query that
    // re-derives `now` per request would see that event fall inside its
    // scan on page 2 and report one person more than page 1 did.
    const landed = `cross-page-landed-${randomUUID()}`
    const clicked = `cross-page-clicked-${randomUUID()}`
    // Real-clock-relative, not the file's `ago()`/NOW -- this fixture needs
    // `until + window` to stay ahead of the ACTUAL wall clock at BOTH
    // requests, which only holds if `until` tracks the real clock too.
    const since = new Date(Date.now() - 3 * HOUR).toISOString()
    const until = new Date(Date.now() - 1000).toISOString()
    const enteredAt = new Date(Date.now() - 2 * MINUTE).toISOString()
    const reachedAt = new Date(Date.now() - 90_000).toISOString()

    const population = MEMBER_PAGE_SIZE + 5
    const batch: object[] = []
    for (let i = 0; i < population; i++) {
      const anon = `sem-cross-page-${i}`
      batch.push(track(anon, landed, enteredAt), track(anon, clicked, reachedAt))
    }
    // Reaches level 1 only, before page 1 -- not part of the level-2
    // population either page should count YET.
    const continuationId = `sem-cross-page-continuation-${randomUUID()}`
    batch.push(track(continuationId, landed, enteredAt))
    for (let i = 0; i < batch.length; i += 400) await send(batch.slice(i, i + 400))

    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: `cross-page-${randomUUID()}`,
        steps: [{ event: landed }, { event: clicked }],
        window_seconds: WINDOW,
      } as never,
    })
    const id = created.json().id

    const page1 = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${id}/people`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { step: 2, mode: 'reached', since, until } as never,
    })
    expect(page1.statusCode).toBe(200)
    const page1Body = page1.json()
    expect(page1Body.members).toHaveLength(MEMBER_PAGE_SIZE)
    expect(page1Body.person_count).toBe(population)
    expect(typeof page1Body.next_cursor).toBe('string')

    // The continuation person's SECOND qualifying event -- strictly between
    // the two requests, timestamped with whatever the wall clock actually
    // is right now, which is necessarily after page 1's pinned asOf.
    await send([track(continuationId, clicked, new Date().toISOString())])

    const page2 = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${id}/people`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { step: 2, mode: 'reached', since, until, cursor: page1Body.next_cursor } as never,
    })
    expect(page2.statusCode).toBe(200)
    const page2Body = page2.json()
    expect(page2Body.members).toHaveLength(population - MEMBER_PAGE_SIZE)
    // The count must not move between pages of the SAME walk -- a count
    // that re-derives `now` per request would report one more here.
    expect(page2Body.person_count).toBe(page1Body.person_count)
    expect(page2Body.person_count).toBe(population)
  })

  describe('step audiences', () => {
    /** `count(event) <op> n` over the last day -- the shape every test here uses. */
    const searchedCount = (operator: '=' | '>=', value: number) => ({
      kind: 'behavior' as const,
      event: 'searched',
      aggregate: 'count' as const,
      window: { kind: 'last' as const, n: 1, unit: 'days' as const },
      operator,
      value,
    })

    /**
     * A page view with a real `context.path`.
     *
     * NOT `track(p, '$page', t, { path: '/docs' })`, which is how this was
     * first written: that puts `path` in the caller's PROPERTY BAG, while an
     * `attribute` predicate reads the `path` COLUMN, which ingest fills from
     * `context.path` alone (`ingest/row.ts`). The two never meet, so the
     * step matched nobody and all three people in the reported-example test
     * came back at level 0 — a failure that reads exactly like a broken
     * audience gate and is nothing of the kind.
     */
    const pageView = (anonymousId: string, path: string, timestamp: string) => ({
      type: 'page',
      message_id: randomUUID(),
      anonymous_id: anonymousId,
      timestamp,
      context: { path },
    })

    /**
     * THE FIXTURE THIS FEATURE EXISTS FOR.
     *
     * A person who satisfies step 1 and fails step 2's audience must appear
     * at LEVEL 1. Not absent. The funnel-wide `segment_id` filter is applied
     * outside the per-person aggregate and would remove them from the report
     * entirely; an audience is folded into the step's own condition and stops
     * them advancing instead. Move the gate and this is the test that says so.
     */
    it('leaves a person who fails a later step’s audience counted at the step they reached', async () => {
      const passes = `aud-pass-${randomUUID()}`
      const fails = `aud-fail-${randomUUID()}`
      await send([
        // Both land and both search. The only difference is HOW MANY times
        // they searched, which is exactly what the audience counts.
        track(passes, 'landed', ago(20 * HOUR)),
        track(passes, 'searched', ago(20 * HOUR - MINUTE)),
        track(fails, 'landed', ago(20 * HOUR)),
        track(fails, 'searched', ago(20 * HOUR - MINUTE)),
        track(fails, 'searched', ago(20 * HOUR - 2 * MINUTE)),
      ])
      const steps = [{ event: 'landed' }, { event: 'searched', audience: searchedCount('=', 1) }]
      expect(await levelOf(passes, { steps })).toBe(2)
      // NOT 0, and not absent.
      expect(await levelOf(fails, { steps })).toBe(1)
    })

    it('bounds entry when the audience is on step 1', async () => {
      const inside = `aud-in-${randomUUID()}`
      const outside = `aud-out-${randomUUID()}`
      await send([
        track(inside, 'searched', ago(21 * HOUR)),
        track(inside, 'searched', ago(21 * HOUR - MINUTE)),
        track(inside, 'landed', ago(20 * HOUR)),
        track(inside, 'clicked', ago(20 * HOUR - MINUTE)),
        track(outside, 'searched', ago(21 * HOUR)),
        track(outside, 'landed', ago(20 * HOUR)),
        track(outside, 'clicked', ago(20 * HOUR - MINUTE)),
      ])
      const steps = [{ event: 'landed', audience: searchedCount('>=', 2) }, { event: 'clicked' }]
      expect(await levelOf(inside, { steps })).toBe(2)
      // Never entered at all -- a person outside step 1's audience has no
      // level, which is a different fact from stopping at step 1.
      expect(await levelOf(outside, { steps })).toBe(0)
    })

    /** The reported question, end to end. */
    it('answers the reported question: a /docs view, then a single retention search', async () => {
      const matches = `aud-ex-ok-${randomUUID()}`
      const searchedTwice = `aud-ex-two-${randomUUID()}`
      const wrongQuery = `aud-ex-q-${randomUUID()}`
      await send([
        pageView(matches, '/docs', ago(20 * HOUR)),
        track(matches, 'docs_search', ago(20 * HOUR - MINUTE), { query: 'retention' }),

        pageView(searchedTwice, '/docs', ago(20 * HOUR)),
        track(searchedTwice, 'docs_search', ago(20 * HOUR - MINUTE), { query: 'retention' }),
        track(searchedTwice, 'docs_search', ago(20 * HOUR - 2 * MINUTE), { query: 'funnels' }),

        pageView(wrongQuery, '/docs', ago(20 * HOUR)),
        track(wrongQuery, 'docs_search', ago(20 * HOUR - MINUTE), { query: 'funnels' }),
      ])
      const steps = [
        {
          event: '$page',
          where: [{ source: 'attribute', attribute: 'path', operator: '=', value: '/docs' }],
        },
        {
          event: 'docs_search',
          where: [{ property: 'query', operator: '=', value: 'retention' }],
          audience: {
            kind: 'behavior',
            event: 'docs_search',
            aggregate: 'count',
            window: { kind: 'last', n: 14, unit: 'days' },
            operator: '=',
            value: 1,
          },
        },
      ]
      expect(await levelOf(matches, { steps })).toBe(2)
      // Searched twice -- fails the AUDIENCE, stops at step 1.
      expect(await levelOf(searchedTwice, { steps })).toBe(1)
      // Searched once, for the wrong thing -- passes the audience, fails the
      // WHERE. Also stops at step 1, by the other route. Both must be
      // reachable or one of the two mechanisms is doing nothing.
      expect(await levelOf(wrongQuery, { steps })).toBe(1)
    })

    /**
     * A step audience and a funnel-wide `segment_id` on the SAME funnel.
     *
     * Nothing else in the product exercises the pair, and the pair is where
     * the two mechanisms would collapse into one without anyone noticing:
     * both compile to `<resolved person> IN (<segment sql>)`, and the only
     * difference is WHERE that clause is placed. The third person is the one
     * that proves they are still distinct — failing the funnel-wide
     * restriction erases you, failing a step's audience does not.
     */
    it('keeps a segment restriction and a step audience doing different things', async () => {
      const inPasses = `aud-combo-pass-${randomUUID()}`
      const inFails = `aud-combo-fail-${randomUUID()}`
      const outside = `aud-combo-out-${randomUUID()}`
      // Its own trait value, so this segment cannot pick up the people the
      // `plan = enterprise` test above identified into the same project.
      const plan = `combo-${randomUUID()}`
      for (const [anon, membership, searches] of [
        [inPasses, plan, 1],
        [inFails, plan, 2],
        // Would pass the step audience with room to spare. The segment is
        // the only reason they must not appear.
        [outside, 'free', 1],
      ] as const) {
        await send([
          {
            type: 'identify',
            message_id: randomUUID(),
            anonymous_id: anon,
            user_id: anon,
            traits: { plan: membership },
          },
          ...Array.from({ length: searches }, (_, i) =>
            track(anon, 'searched', ago(21 * HOUR - i * MINUTE)),
          ),
          track(anon, 'landed', ago(20 * HOUR)),
          track(anon, 'clicked', ago(20 * HOUR - MINUTE)),
        ])
      }
      await reloadIdentityDictionaries()

      const seg = await pg.query<{ id: string }>(
        `INSERT INTO segments (project_id, name, filter, ast_version)
         VALUES ($1, $2, $3::jsonb, 1) RETURNING id`,
        [
          projectId,
          `combo-${randomUUID()}`,
          JSON.stringify({ kind: 'trait', key: 'plan', operator: '=', value: plan }),
        ],
      )
      const segmentId = Number(seg.rows[0]?.id)
      try {
        const steps = [{ event: 'landed' }, { event: 'clicked', audience: searchedCount('=', 1) }]
        const overrides = { steps, segment_id: segmentId }
        // In the segment, inside the audience: all the way through.
        expect(await levelOf(inPasses, overrides)).toBe(2)
        // In the segment, outside the audience: STILL COUNTED, at step 1.
        expect(await levelOf(inFails, overrides)).toBe(1)
        // Outside the segment: gone. Not level 1 — absent.
        //
        // What this pins is that the restriction is APPLIED AT ALL: delete
        // `segmentFilter` from `compileFunnel` and this reads 2. It does NOT
        // pin where the restriction sits, and an earlier version of this
        // comment claimed it did. Folding `segmentPersonSql` into every step
        // condition and deleting `segmentFilter` leaves this whole file
        // green, because that rewrite is behaviour-preserving: a
        // person-constant false condition on step 1 gives level 0, and the
        // outer `WHERE level > 0` gives level 0 too. The placement that is
        // pinned is the AUDIENCE's, by the test at the top of this block.
        expect(await levelOf(outside, overrides)).toBe(0)
        // ...and without the restriction, that same person is level 2, so
        // the 0 above is the segment and not a broken fixture.
        expect(await levelOf(outside, { steps })).toBe(2)
      } finally {
        await pg.query('DELETE FROM segments WHERE id = $1', [segmentId])
      }
    })

    /**
     * TWO AUDIENCES, DIFFERENT ONES, IN ONE FUNNEL — the shape every other
     * fixture in this block avoids.
     *
     * All of them use one audience on a two-step funnel, so nothing yet says
     * a funnel's audiences are told apart at all: reusing the first gate for
     * every audienced step satisfies every test above. It also puts an
     * audience on the LAST step of a three-step funnel, and it puts two
     * independently compiled `WITH base AS (…) SELECT …` subqueries — each
     * with its own `base`, `traits` and `beh` — inside one ClickHouse query,
     * where a CTE name resolved across the pair rather than within it would
     * silently give both gates the same population.
     *
     * The three people are chosen so that each gate is the ONLY thing
     * separating two of them.
     */
    it('tells two different step audiences apart within one funnel', async () => {
      const both = `aud-two-both-${randomUUID()}`
      const firstOnly = `aud-two-first-${randomUUID()}`
      const secondOnly = `aud-two-second-${randomUUID()}`
      await send([
        track(both, 'searched', ago(21 * HOUR)),
        track(both, 'searched', ago(21 * HOUR - MINUTE)),
        track(both, 'browsed', ago(21 * HOUR - 2 * MINUTE)),
        track(firstOnly, 'searched', ago(21 * HOUR)),
        track(firstOnly, 'searched', ago(21 * HOUR - MINUTE)),
        track(secondOnly, 'searched', ago(21 * HOUR)),
        track(secondOnly, 'browsed', ago(21 * HOUR - 2 * MINUTE)),
      ])
      await send(
        [both, firstOnly, secondOnly].flatMap((p) => [
          track(p, 'landed', ago(20 * HOUR)),
          track(p, 'clicked', ago(20 * HOUR - MINUTE)),
          track(p, 'converted', ago(20 * HOUR - 2 * MINUTE)),
        ]),
      )
      const steps = [
        { event: 'landed', audience: searchedCount('>=', 2) },
        { event: 'clicked' },
        {
          event: 'converted',
          audience: {
            kind: 'behavior',
            event: 'browsed',
            aggregate: 'count',
            window: { kind: 'last', n: 1, unit: 'days' },
            operator: '>=',
            value: 1,
          },
        },
      ]
      // Passes both gates.
      expect(await levelOf(both, { steps })).toBe(3)
      // Passes step 1's gate, fails step 3's — so the last step is the one
      // that stops them, and they are still counted at step 2.
      expect(await levelOf(firstOnly, { steps })).toBe(2)
      // Fails step 1's gate. Would pass step 3's, which is exactly why they
      // are here: if both steps were gated by the SAME compiled audience,
      // this person and `firstOnly` would swap answers.
      expect(await levelOf(secondOnly, { steps })).toBe(0)
    })

    /**
     * THE GATE IS JUDGED PER PERSON, NOT PER DEVICE.
     *
     * Every other fixture in this block puts the gating events and the
     * funnel-step events under ONE `anonymous_id`, so the audience resolves
     * whoever the funnel resolves no matter how either side does it. But the
     * gate is `<resolved person> IN (<segment persons>)` — TWO independent
     * resolutions, in two independently compiled queries, that have to agree
     * about who a person is. The file pins identity for the funnel itself
     * (see the identify-mid-funnel test above) and, until this, never for
     * the gate.
     *
     * Both searches happen on device A; the whole funnel happens on device
     * B; both devices are identified to one user. `soloUser` is the same
     * two-device shape with ONE search, so the negative direction is pinned
     * by a fixture that differs only in the count the audience reads.
     *
     * Resolution canonicalises to the `user_id`, so the drop-off list
     * contains NEITHER anonymous id. Asking `levelOf` for a device id alone
     * reads 0 for both people and passes for entirely the wrong reason —
     * hence `levelOfPerson`, which is this file's existing
     * `id === anon || id === userId` hedge in the shape `levelOf` needs.
     */
    it('judges an audience per person, across two devices', async () => {
      const deviceA = `aud-idA-${randomUUID()}`
      const deviceB = `aud-idB-${randomUUID()}`
      const user = `aud-iduser-${randomUUID()}`
      const soloA = `aud-soloA-${randomUUID()}`
      const soloB = `aud-soloB-${randomUUID()}`
      const soloUser = `aud-solouser-${randomUUID()}`
      await send([
        // Two searches, both on device A only.
        track(deviceA, 'searched', ago(21 * HOUR)),
        track(deviceA, 'searched', ago(21 * HOUR - MINUTE)),
        { type: 'identify', message_id: randomUUID(), anonymous_id: deviceA, user_id: user },
        { type: 'identify', message_id: randomUUID(), anonymous_id: deviceB, user_id: user },
        // ONE search on device A only -- the control, same two-device shape.
        track(soloA, 'searched', ago(21 * HOUR)),
        { type: 'identify', message_id: randomUUID(), anonymous_id: soloA, user_id: soloUser },
        { type: 'identify', message_id: randomUUID(), anonymous_id: soloB, user_id: soloUser },
      ])
      await reloadIdentityDictionaries()
      await send([
        // The funnel itself happens entirely on device B.
        track(deviceB, 'landed', ago(20 * HOUR)),
        track(deviceB, 'clicked', ago(20 * HOUR - MINUTE)),
        track(soloB, 'landed', ago(20 * HOUR)),
        track(soloB, 'clicked', ago(20 * HOUR - MINUTE)),
      ])
      const steps = [{ event: 'landed', audience: searchedCount('>=', 2) }, { event: 'clicked' }]
      /** The level of whichever id the resolution canonicalised to. */
      const levelOfPerson = async (...ids: string[]): Promise<number> => {
        for (const id of ids) {
          const level = await levelOf(id, { steps })
          if (level > 0) return level
        }
        return 0
      }
      // The searches are on the OTHER device. Judged per person, this is 2.
      expect(await levelOfPerson(deviceB, deviceA, user)).toBe(2)
      // Same shape, one search: outside the audience, so no level at all.
      expect(await levelOfPerson(soloB, soloA, soloUser)).toBe(0)
    })

    /**
     * A TRAIT audience, which reaches the engine by a different route.
     *
     * Every other audience here is a `behavior` node, so every one of them
     * builds a behavioural CTE and reads it back. A trait node builds none:
     * it is answered entirely out of the `traits` CTE that `compileSegment`
     * assembles for every tree whether or not anything reads it. Coverage
     * for that path against a live engine, not a new theme — which is why
     * the two people differ only in one trait.
     */
    it('gates a step on a trait, not only on a behaviour', async () => {
      const pro = `aud-trait-pro-${randomUUID()}`
      const basic = `aud-trait-basic-${randomUUID()}`
      // Its own key, so no other test's traits can answer this audience.
      const key = `aud_tier_${randomUUID().replaceAll('-', '')}`
      for (const [anon, tier] of [
        [pro, 'pro'],
        [basic, 'basic'],
      ] as const) {
        await send([
          {
            type: 'identify',
            message_id: randomUUID(),
            anonymous_id: anon,
            user_id: anon,
            traits: { [key]: tier },
          },
          track(anon, 'landed', ago(20 * HOUR)),
          track(anon, 'clicked', ago(20 * HOUR - MINUTE)),
        ])
      }
      await reloadIdentityDictionaries()
      const steps = [
        { event: 'landed' },
        {
          event: 'clicked',
          audience: { kind: 'trait', key, operator: '=', value: 'pro' },
        },
      ]
      expect(await levelOf(pro, { steps })).toBe(2)
      // Counted at the step they reached, exactly as a behavioural audience
      // leaves them -- the semantics do not depend on the node kind.
      expect(await levelOf(basic, { steps })).toBe(1)
    })

    it('runs a definition with no audience exactly as it did before', async () => {
      const person = `aud-none-${randomUUID()}`
      await send([
        track(person, 'landed', ago(20 * HOUR)),
        track(person, 'clicked', ago(20 * HOUR - MINUTE)),
        track(person, 'converted', ago(20 * HOUR - 2 * MINUTE)),
      ])
      expect(await levelOf(person)).toBe(3)
    })
  })

  /**
   * WHO IS AT A STEP — `/v1/funnels/:id/people`, against the live engine.
   *
   * Everything above proves what LEVEL a person reached. This block proves
   * the two populations `/people` builds on top of a level: `reached`
   * (`level >= N` — the population a chart bar labelled with step N's count
   * means) and `dropped` (`level = N` — the population `/dropoff` has always
   * returned). They are one operator apart in `compile.ts` and each answers
   * the other's question with complete confidence, so every assertion here
   * is an EXACT SET rather than a `some(...)`.
   *
   * Which is only possible because every fixture below names its OWN events.
   * The plain `landed`/`clicked`/`converted` chain is shared by a dozen tests
   * in this file, in one shared project — an exact-set assertion over it
   * would be a test of whatever the rest of the file happened to seed.
   *
   * `RANGE` verbatim on every call, never `new Date()`: several tests here
   * compare a number from one request against a number from another, and a
   * moving `until` moves the scan's end between the two.
   */
  describe('step people', () => {
    /** A funnel of one's own, so its population is exactly what was seeded. */
    async function createFunnel(steps: object[], extra: object = {}): Promise<number> {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/funnels',
        headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
        payload: {
          name: `people-${randomUUID()}`,
          steps,
          window_seconds: WINDOW,
          ...extra,
        } as never,
      })
      expect(created.statusCode).toBe(201)
      return created.json().id as number
    }

    /**
     * The wire shape this block reads. Narrower than `PeopleRow` on purpose:
     * naming `traits_num` and `trait_total` here is what lets the traits test
     * assert on them without a cast, and a cast is how a test ends up
     * asserting against a field the response does not carry.
     */
    interface PeoplePage {
      members: {
        person_id: string
        traits: Record<string, string>
        traits_num: Record<string, number>
        trait_total: number
      }[]
      person_count: number
      next_cursor: string | null
    }

    async function peoplePage(
      id: number,
      step: number,
      mode: 'reached' | 'dropped',
      extra: object = {},
    ): Promise<PeoplePage> {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/funnels/${id}/people`,
        headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
        payload: { step, mode, ...RANGE, ...extra } as never,
      })
      expect(res.statusCode).toBe(200)
      return res.json()
    }

    /**
     * A second step nobody ever emits.
     *
     * `FunnelDefinition` requires at least two steps -- "a one-step funnel is
     * a count" (ast.ts) -- and several fixtures below only have a question
     * about step 1. Padding with an event that was never sent leaves step 1's
     * population untouched and keeps the funnel legal.
     */
    const unreachedStep = () => ({ event: `sp-never-${randomUUID()}` })

    /** The person ids on one page, sorted, for an exact-set comparison. */
    const idsAt = async (id: number, step: number, mode: 'reached' | 'dropped') =>
      (await peoplePage(id, step, mode)).members.map((m) => m.person_id).sort()

    /**
     * THE FIXTURE THIS ENDPOINT EXISTS FOR: one person stops at step 1, one
     * goes all the way through, and the four (step, mode) questions have four
     * different right answers.
     */
    it('separates who REACHED a step from who STOPPED at it', async () => {
      const s1 = `sp-a1-${randomUUID()}`
      const s2 = `sp-a2-${randomUUID()}`
      const stopper = `sp-stopper-${randomUUID()}`
      const converter = `sp-converter-${randomUUID()}`
      await send([
        track(stopper, s1, ago(20 * HOUR)),
        track(converter, s1, ago(20 * HOUR)),
        track(converter, s2, ago(20 * HOUR - MINUTE)),
      ])
      const id = await createFunnel([{ event: s1 }, { event: s2 }])

      // THE ASSERTION THE `level >=` -> `level =` MUTATION BREAKS. Under that
      // mutation `reached` at step 1 loses the converter, because they are at
      // level 2 -- and every other assertion in this test still passes, which
      // is exactly why the pair is written out rather than one of them.
      expect(await idsAt(id, 1, 'reached')).toEqual([converter, stopper].sort())
      expect(await idsAt(id, 1, 'dropped')).toEqual([stopper])

      expect(await idsAt(id, 2, 'reached')).toEqual([converter])
      // NOT empty, and the brief said it would be. `windowFunnel`'s level is
      // "got no further than this", so someone who finished the funnel has
      // stopped at its LAST step: `level = 2` returns the converter. This is
      // not new behaviour to argue with -- `/dropoff` has always answered the
      // final step this way (see `levels.ts`), and `/people` inherits it by
      // sharing the compile path. The truth, asserted, rather than the
      // summary.
      expect(await idsAt(id, 2, 'dropped')).toEqual([converter])

      // The count travels with the page and is mode-aware too.
      expect((await peoplePage(id, 1, 'reached')).person_count).toBe(2)
      expect((await peoplePage(id, 1, 'dropped')).person_count).toBe(1)
      expect((await peoplePage(id, 2, 'reached')).person_count).toBe(1)
      expect((await peoplePage(id, 2, 'dropped')).person_count).toBe(1)
    })

    /**
     * THE ONLY TEST THAT SAYS THE TWO CODE PATHS AGREE.
     *
     * A run's `steps[N-1].people` comes from the level histogram summed by
     * `summarise`; `/people`'s `person_count` for `reached` comes from a
     * `count()` over `level >= N` in ClickHouse. Completely different
     * queries, one shared meaning. Three steps with three DIFFERENT
     * populations, so a count that is constant, off by one, or reading the
     * wrong step cannot satisfy all three -- and the expected numbers are
     * asserted outright as well, so the two paths agreeing on a wrong answer
     * is not a pass either.
     */
    it("agrees with the run: person_count for `reached` at step N is the run's steps[N-1].people", async () => {
      const s1 = `sp-b1-${randomUUID()}`
      const s2 = `sp-b2-${randomUUID()}`
      const s3 = `sp-b3-${randomUUID()}`
      const batch: object[] = []
      // 3 stop at step 1, 2 stop at step 2, 1 converts: 6 / 3 / 1 by step.
      for (let i = 0; i < 6; i++) {
        const p = `sp-agree-${i}-${randomUUID()}`
        batch.push(track(p, s1, ago(20 * HOUR)))
        if (i >= 3) batch.push(track(p, s2, ago(20 * HOUR - MINUTE)))
        if (i >= 5) batch.push(track(p, s3, ago(20 * HOUR - 2 * MINUTE)))
      }
      await send(batch)
      const id = await createFunnel([{ event: s1 }, { event: s2 }, { event: s3 }])

      const ran = await app.inject({
        method: 'POST',
        url: `/v1/funnels/${id}/run`,
        headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
        payload: { ...RANGE } as never,
      })
      expect(ran.statusCode).toBe(200)
      const steps = ran.json().steps as { people: number }[]

      const expected = [6, 3, 1]
      for (let step = 1; step <= 3; step++) {
        const page = await peoplePage(id, step, 'reached')
        expect(page.person_count).toBe(steps[step - 1]?.people)
        expect(page.person_count).toBe(expected[step - 1])
        // And the page itself holds that many rows -- so a count query that
        // is right about a population the row query does not return would
        // still fail here.
        expect(page.members).toHaveLength(expected[step - 1] as number)
      }
    })

    /**
     * A `/people` row is a MEMBER row, traits and all -- that is the whole
     * reason the endpoint exists rather than `/dropoff` growing a mode.
     *
     * The person with no traits is the half that matters: `traits` must be an
     * empty map, not a missing key. `MemberList` reads `Object.entries(row.traits)`,
     * and a LEFT JOIN that produced `undefined` instead of `{}` would throw
     * in the browser for exactly the people who are hardest to notice.
     */
    it('returns traits on the page, and empty maps rather than a missing key', async () => {
      const s1 = `sp-c1-${randomUUID()}`
      const traited = `sp-traited-${randomUUID()}`
      const bare = `sp-bare-${randomUUID()}`
      // Its own keys, so no other fixture in this shared project can answer
      // for them.
      const strKey = `sp_tier_${randomUUID().replaceAll('-', '')}`
      const numKey = `sp_seats_${randomUUID().replaceAll('-', '')}`
      await send([
        {
          type: 'identify',
          message_id: randomUUID(),
          // user_id === anonymous_id so resolution canonicalises to the id
          // this test asserts on, rather than to a second one it would then
          // have to hedge about.
          anonymous_id: traited,
          user_id: traited,
          traits: { [strKey]: 'pro', [numKey]: 7 },
        },
        track(traited, s1, ago(20 * HOUR)),
        track(bare, s1, ago(20 * HOUR)),
      ])
      await reloadIdentityDictionaries()
      const id = await createFunnel([{ event: s1 }, unreachedStep()])

      const page = await peoplePage(id, 1, 'reached')
      expect(page.members.map((m) => m.person_id).sort()).toEqual([bare, traited].sort())

      const withTraits = page.members.find((m) => m.person_id === traited)
      expect(withTraits?.traits[strKey]).toBe('pro')
      // A numeric trait travels in the OTHER map -- `t_has_num` decides which,
      // and a row carrying `{seats: "7"}` in `traits` would be the drift
      // `traitsCte`'s own comment warns about.
      expect(withTraits?.traits_num[numKey]).toBe(7)
      expect(withTraits?.trait_total).toBe(2)

      const without = page.members.find((m) => m.person_id === bare)
      expect(without).toBeDefined()
      // Present and empty, in both maps -- `toEqual({})` alone would pass for
      // `undefined` on neither, but the key check says the field exists at all.
      expect(Object.hasOwn(without as object, 'traits')).toBe(true)
      expect(Object.hasOwn(without as object, 'traits_num')).toBe(true)
      expect(without?.traits).toEqual({})
      expect(without?.traits_num).toEqual({})
      expect(without?.trait_total).toBe(0)
    })

    /**
     * SUPPRESSION IS INHERITED, IN `reached` MODE TOO.
     *
     * `/people` gets it by compiling through the same `perPerson` pass the
     * run and `/dropoff` use, and inheritance is precisely what a refactor
     * drops without anything going red. Both the page AND the count are
     * checked: they are two compiled queries, and a filter can go missing
     * from one of them alone.
     */
    it('still excludes a deleted person in `reached` mode, from the page and from the count', async () => {
      const s1 = `sp-d1-${randomUUID()}`
      const doomed = `sp-doomed-${randomUUID()}`
      const survivor = `sp-survivor-${randomUUID()}`
      await send([
        // Identified, because DELETE needs a person the API can name -- an
        // anonymous-only visitor answers 404 (a documented limitation, not a
        // funnel defect).
        {
          type: 'identify',
          message_id: randomUUID(),
          anonymous_id: doomed,
          user_id: doomed,
        },
        track(doomed, s1, ago(20 * HOUR)),
        track(survivor, s1, ago(20 * HOUR)),
      ])
      await reloadIdentityDictionaries()
      const id = await createFunnel([{ event: s1 }, unreachedStep()])

      expect(await idsAt(id, 1, 'reached')).toEqual([doomed, survivor].sort())
      expect((await peoplePage(id, 1, 'reached')).person_count).toBe(2)

      const del = await app.inject({
        method: 'DELETE',
        url: `/v1/persons/${encodeURIComponent(doomed)}`,
        headers: { 'x-lyraflow-server-key': SERVER_KEY },
      })
      expect([200, 202]).toContain(del.statusCode)

      // The survivor is still there -- a suppression filter that removed
      // everybody would satisfy "the deleted person is gone" perfectly.
      expect(await idsAt(id, 1, 'reached')).toEqual([survivor])
      expect((await peoplePage(id, 1, 'reached')).person_count).toBe(1)
    })

    /**
     * THE FUNNEL'S `segment_id` IS INHERITED TOO, in `reached` mode.
     *
     * The differential is the point: the same events, the same step, two
     * funnels differing only in the restriction. A restriction that matched
     * nobody and one that was silently dropped both look correct against a
     * single assertion, and neither survives the pair.
     */
    it('still restricts `reached` to the funnel’s segment', async () => {
      const s1 = `sp-e1-${randomUUID()}`
      const inside = `sp-in-${randomUUID()}`
      const outside = `sp-out-${randomUUID()}`
      // Its own trait value, so no other test's `enterprise` people can join
      // this segment.
      const plan = `sp-plan-${randomUUID()}`
      for (const [anon, membership] of [
        [inside, plan],
        [outside, 'free'],
      ] as const) {
        await send([
          {
            type: 'identify',
            message_id: randomUUID(),
            anonymous_id: anon,
            user_id: anon,
            traits: { plan: membership },
          },
          track(anon, s1, ago(20 * HOUR)),
        ])
      }
      await reloadIdentityDictionaries()

      const seg = await pg.query<{ id: string }>(
        `INSERT INTO segments (project_id, name, filter, ast_version)
         VALUES ($1, $2, $3::jsonb, 1) RETURNING id`,
        [
          projectId,
          `sp-seg-${randomUUID()}`,
          JSON.stringify({ kind: 'trait', key: 'plan', operator: '=', value: plan }),
        ],
      )
      const segmentId = Number(seg.rows[0]?.id)
      try {
        const wide = await createFunnel([{ event: s1 }, unreachedStep()])
        const narrow = await createFunnel([{ event: s1 }, unreachedStep()], {
          segment_id: segmentId,
        })

        expect(await idsAt(wide, 1, 'reached')).toEqual([inside, outside].sort())
        expect((await peoplePage(wide, 1, 'reached')).person_count).toBe(2)

        // Not "fewer": exactly the one person in the segment, in the page and
        // in the separately compiled count.
        expect(await idsAt(narrow, 1, 'reached')).toEqual([inside])
        expect((await peoplePage(narrow, 1, 'reached')).person_count).toBe(1)
      } finally {
        await pg.query('DELETE FROM segments WHERE id = $1', [segmentId])
      }
    })

    /**
     * PAGING `reached` PAST `MEMBER_PAGE_SIZE`.
     *
     * Every entrant shares ONE instant, deliberately -- the same reasoning as
     * the `/dropoff` paging test above. Spacing them a second apart gives
     * every row a distinct `entered_at`, the tie-breaker in the keyset is then
     * never consulted, and a cursor collapsed to `entered_at <` alone looks
     * perfect. Ties are the only shape that tests the boundary instant.
     */
    it('pages `reached` past MEMBER_PAGE_SIZE without repeating or skipping the boundary instant', async () => {
      const s1 = `sp-f1-${randomUUID()}`
      const population = MEMBER_PAGE_SIZE + 5
      const ids = Array.from(
        { length: population },
        (_, i) => `sp-page-${String(i).padStart(3, '0')}-${randomUUID()}`,
      )
      const batch = ids.map((p) => track(p, s1, ago(20 * HOUR)))
      // Batches are capped at 500 payloads, so this goes in chunks.
      for (let i = 0; i < batch.length; i += 400) await send(batch.slice(i, i + 400))
      const id = await createFunnel([{ event: s1 }, unreachedStep()])

      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const body: PeoplePage = await peoplePage(id, 1, 'reached', cursor ? { cursor } : {})
        expect(body.person_count).toBe(population)
        seen.push(...body.members.map((m) => m.person_id))
        cursor = body.next_cursor
        if (!cursor) break
      }
      // It genuinely paged rather than fitting in one response...
      expect(seen.length).toBeGreaterThan(MEMBER_PAGE_SIZE)
      // ...nobody twice...
      expect(new Set(seen).size).toBe(seen.length)
      // ...and exactly the seeded population, so a walk that skipped the
      // people sharing the boundary instant fails here rather than passing a
      // duplicate check it never had a chance to break.
      expect([...seen].sort()).toEqual([...ids].sort())
    })

    /**
     * THE COMPLEMENT OF THE TEST ABOVE: DISTINCT INSTANTS, so the SORT
     * DIRECTION is observable.
     *
     * The tie fixture above is right to put every entrant at one instant --
     * that is the only shape that consults the keyset's tie-breaker. But it
     * has a blind spot, and so does every other `/people` fixture in this
     * file, because they all share that instant too: with every `entered_at`
     * equal, `ORDER BY entered_at DESC` and `ASC` return the same rows in the
     * same order, and the direction is pinned by nothing. Flipping it left all
     * 33 tests green.
     *
     * It is not cosmetic. The keyset resumes with `entered_at < cursor`, which
     * is only a continuation of a DESCENDING walk. Under `ASC` the cursor
     * carries the LARGEST instant seen, so page two re-serves the start of the
     * same population: the walk repeats rows instead of advancing.
     *
     * One minute apart, which is also this file's spacing rule -- `WINDOW` is
     * 3600, so hour-spaced entrants would sit on the window boundary.
     */
    it('pages `reached` in one direction when every entrant has a DISTINCT instant', async () => {
      const s1 = `sp-i1-${randomUUID()}`
      const population = MEMBER_PAGE_SIZE + 5
      const ids = Array.from(
        { length: population },
        (_, i) => `sp-order-${String(i).padStart(3, '0')}-${randomUUID()}`,
      )
      // Every entrant a minute apart, newest first, and all of them inside
      // RANGE: 105 minutes back from 20 hours ago is still well short of
      // `since`.
      const batch = ids.map((p, i) => track(p, s1, ago(20 * HOUR + i * MINUTE)))
      for (let i = 0; i < batch.length; i += 400) await send(batch.slice(i, i + 400))
      const id = await createFunnel([{ event: s1 }, unreachedStep()])

      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const body: PeoplePage = await peoplePage(id, 1, 'reached', cursor ? { cursor } : {})
        expect(body.person_count).toBe(population)
        seen.push(...body.members.map((m) => m.person_id))
        cursor = body.next_cursor
        if (!cursor) break
      }
      expect(seen.length).toBeGreaterThan(MEMBER_PAGE_SIZE)
      // Both halves are needed and neither is redundant. A walk sorted the
      // wrong way round re-serves people it has already sent, so it fails the
      // duplicate check; one that also drops the tail fails the set check.
      expect(new Set(seen).size).toBe(seen.length)
      expect([...seen].sort()).toEqual([...ids].sort())
      // And the direction read straight off page one rather than inferred
      // from the walk: newest entrant first, which is what the keyset's `<`
      // is a continuation of. `ids` was seeded newest-first, so this is the
      // seeding order unchanged.
      const firstPage = await peoplePage(id, 1, 'reached')
      expect(firstPage.members.map((m) => m.person_id)).toEqual(ids.slice(0, MEMBER_PAGE_SIZE))
    })

    /**
     * THE COLUMN, not the direction: everything above gives each person
     * exactly one event, so `entered_at` and `last_seen` are the same value
     * and sorting by either produces the same walk. Pin the column by
     * breaking that tie -- a second, non-funnel event per person, timed so
     * `last_seen`'s order is the REVERSE of `entered_at`'s. If the walk is
     * ever sorted by `last_seen` instead, page two re-serves page one and
     * the tail is never reached.
     */
    it('pages `reached` by entered_at, not by last_seen, when a second event moves the two apart', async () => {
      const s1 = `sp-o2-${randomUUID()}`
      const other = `sp-o2-other-${randomUUID()}`
      const population = MEMBER_PAGE_SIZE + 5
      const ids = Array.from(
        { length: population },
        (_, i) => `sp-order-col-${String(i).padStart(3, '0')}-${randomUUID()}`,
      )
      const entryBatch = ids.map((p, i) => track(p, s1, ago(20 * HOUR + i * MINUTE)))
      // Always more recent than the funnel event above (10h base vs 20h),
      // so `last_seen` is exactly this timestamp -- and offset in the
      // OPPOSITE order, so its ranking across the population is reversed.
      const otherBatch = ids.map((p, i) =>
        track(p, other, ago(10 * HOUR + (population - 1 - i) * MINUTE)),
      )
      for (let i = 0; i < entryBatch.length; i += 400) await send(entryBatch.slice(i, i + 400))
      for (let i = 0; i < otherBatch.length; i += 400) await send(otherBatch.slice(i, i + 400))
      const id = await createFunnel([{ event: s1 }, unreachedStep()])

      const seen: string[] = []
      let cursor: string | null = null
      for (let page = 0; page < 10; page++) {
        const body: PeoplePage = await peoplePage(id, 1, 'reached', cursor ? { cursor } : {})
        expect(body.person_count).toBe(population)
        seen.push(...body.members.map((m) => m.person_id))
        cursor = body.next_cursor
        if (!cursor) break
      }
      expect(seen.length).toBeGreaterThan(MEMBER_PAGE_SIZE)
      expect(new Set(seen).size).toBe(seen.length)
      expect([...seen].sort()).toEqual([...ids].sort())
    })

    /**
     * MY OWN MUTATION -- a STEP AUDIENCE read through `/people`, which is the
     * one combination nothing else in this plan or this file puts together.
     *
     * The shape every `/people` fixture has in common is a funnel of plain
     * events, and the shape every audience fixture has in common is reading
     * the answer through `/dropoff`, whose `select: 'ids'` compiles no CTEs
     * of its own. `select: 'members'` does: it wraps the per-person pass in
     * `WITH base AS (…), traits AS (…)`. An audience compiles a whole
     * `compileSegment` -- which builds its OWN `base`, `traits` and `beh`
     * CTEs -- into an `IN (…)` INSIDE that per-person pass. So this query
     * nests a `WITH base` inside a `WITH base`, which the file's own
     * two-audiences test already names as the failure mode to fear: "a CTE
     * name resolved across the pair rather than within it would silently give
     * both gates the same population". Here the outer `base` is not another
     * gate but the member projection's own join source, so a leak in either
     * direction is worse than a wrong gate -- it is a wrong person row.
     *
     * Three people, so both directions are pinned: one passes the gate, one
     * fails it and must still appear at step 1, and one is outside the funnel
     * entirely.
     */
    it('applies a step audience to a `/people` page, whose member CTEs share its names', async () => {
      const s1 = `sp-g1-${randomUUID()}`
      const s2 = `sp-g2-${randomUUID()}`
      const gate = `sp-gate-${randomUUID()}`
      const passes = `sp-aud-pass-${randomUUID()}`
      const fails = `sp-aud-fail-${randomUUID()}`
      await send([
        // Two gate events for one, one for the other -- the only difference
        // between them, so the audience is the only thing that can separate
        // them.
        track(passes, gate, ago(21 * HOUR)),
        track(passes, gate, ago(21 * HOUR - MINUTE)),
        track(fails, gate, ago(21 * HOUR)),
        track(passes, s1, ago(20 * HOUR)),
        track(passes, s2, ago(20 * HOUR - MINUTE)),
        track(fails, s1, ago(20 * HOUR)),
        track(fails, s2, ago(20 * HOUR - MINUTE)),
      ])
      const id = await createFunnel([
        { event: s1 },
        {
          event: s2,
          audience: {
            kind: 'behavior',
            event: gate,
            aggregate: 'count',
            window: { kind: 'last', n: 1, unit: 'days' },
            operator: '>=',
            value: 2,
          },
        },
      ])

      // Both entered, so step 1 `reached` is both -- the audience must not
      // erase anyone from the report.
      expect(await idsAt(id, 1, 'reached')).toEqual([fails, passes].sort())
      // Only the gated one advanced.
      expect(await idsAt(id, 2, 'reached')).toEqual([passes])
      expect((await peoplePage(id, 2, 'reached')).person_count).toBe(1)
      // And the other stopped at step 1 rather than vanishing.
      expect(await idsAt(id, 1, 'dropped')).toEqual([fails])
    })

    /**
     * MY SECOND MUTATION -- ONE PERSON, TWO IDS, ONE ROW.
     *
     * The shape every `/people` fixture shares, mine and Task 2's alike, is a
     * person who exists under a single anonymous id. That hides the join this
     * projection is built on: `perPerson` resolves identity from the EVENT's
     * own timestamp, while `base` and `traits` resolve it independently --
     * `traits` at `now()`, from a different table entirely. Three resolutions,
     * one row, and nothing above asks them to agree.
     *
     * The count is the assertion that matters. If the funnel pass and the
     * member join disagreed about who this is, the honest failure is not a
     * missing trait but TWO rows -- the anonymous half at level 1 and the
     * identified half at level 1 -- which reads as a perfectly plausible page
     * unless the test says how many people there are supposed to be.
     */
    it('returns ONE row for a person identified in the middle of the funnel', async () => {
      const s1 = `sp-h1-${randomUUID()}`
      const s2 = `sp-h2-${randomUUID()}`
      const anon = `sp-id-anon-${randomUUID()}`
      const user = `sp-id-user-${randomUUID()}`
      const key = `sp_role_${randomUUID().replaceAll('-', '')}`
      await send([track(anon, s1, ago(20 * HOUR))])
      await send([
        {
          type: 'identify',
          message_id: randomUUID(),
          anonymous_id: anon,
          user_id: user,
          traits: { [key]: 'admin' },
        },
      ])
      await reloadIdentityDictionaries()
      // Step 2 arrives as the KNOWN user, on the far side of the identify.
      await send([
        {
          type: 'track',
          message_id: randomUUID(),
          user_id: user,
          event: s2,
          timestamp: ago(20 * HOUR - MINUTE),
        },
      ])
      const id = await createFunnel([{ event: s1 }, { event: s2 }])

      const page = await peoplePage(id, 2, 'reached')
      // ONE person, not two halves of one.
      expect(page.members).toHaveLength(1)
      expect(page.person_count).toBe(1)
      const row = page.members[0]
      // Under whichever id resolution canonicalises to -- this file's standing
      // hedge, because which one it is is not this test's claim.
      expect([anon, user]).toContain(row?.person_id)
      // The traits were written against the ANONYMOUS id and the funnel found
      // this person through the USER id. The trait map is where those two
      // resolutions have to meet.
      expect(row?.traits[key]).toBe('admin')

      // And step 1 holds the same single person, not the anonymous half on
      // its own -- `reached` at step 1 is where a split would show as two.
      const first = await peoplePage(id, 1, 'reached')
      expect(first.members).toHaveLength(1)
      expect(first.person_count).toBe(1)
    })
  })

  /**
   * The level one specific person reached, read THROUGH the product.
   *
   * Deliberately not a hand-written windowFunnel query against ClickHouse:
   * that would prove my SQL agrees with itself and nothing about the engine.
   * A person appears in exactly one drop-off list — the level they stopped at
   * — so walking the levels through the real endpoint both isolates the
   * person and exercises the code under test.
   */
  async function levelOf(
    personId: string,
    overrides: { steps?: unknown[] } & Record<string, unknown> = {},
  ): Promise<number> {
    // From the OVERRIDE when there is one -- `STEPS.length` is 3, and a
    // two-step override asking for level 3 is a question the endpoint has no
    // answer to (it answers 400, and the `expect` inside `dropoffPeopleFor`
    // turns that into a failure that looks like the feature is broken).
    const count = (overrides.steps ?? STEPS).length
    for (let step = 1; step <= count; step++) {
      if ((await dropoffPeopleFor(step, overrides)).includes(personId)) return step
    }
    return 0
  }

  /** Creates a throwaway saved funnel and lists its drop-offs at `step`. */
  async function dropoffPeopleFor(step: number, overrides: object = {}): Promise<string[]> {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: `dropoff-${randomUUID()}`,
        steps: STEPS,
        window_seconds: WINDOW,
        ...overrides,
      } as never,
    })
    expect(created.statusCode).toBe(201)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funnels/${created.json().id}/dropoff`,
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: { step, since: RANGE.since, until: new Date().toISOString() } as never,
    })
    expect(res.statusCode).toBe(200)
    return res.json().people.map((r: { person_id: string }) => r.person_id)
  }
})

describe('optional steps, against real rows', () => {
  // $page -> signed_up -> subscription_started -> [video_submitted] -> subscription_canceled
  //
  // Event names are TAGGED per test ($page-<tag>, etc.) rather than shared
  // across this whole describe block. Every `journey()` call anchors at the
  // exact same instant (`RANGE.since + 60s` -- see `journey` above) and
  // `preview` aggregates over the WHOLE project and range, not "this test's
  // people": two tests sharing one event vocabulary are indistinguishable to
  // it. Running the brief's tests verbatim with one shared `STEPS_OPT`
  // proved this by accumulation -- `converted` read as the sum of every
  // journey seeded so far in the block (1 became 2, then 2, then 6...),
  // which is cross-test bleed, not a defect in compile.ts/levels.ts. The
  // rest of this file already works around the same hazard on its shared
  // `STEPS` (`excludes a deleted person...` diffs a before/after count
  // rather than asserting one absolute; `ACTUALLY restricts the population
  // to a segment...` uses `toBeGreaterThanOrEqual`/`toBeLessThan`). Tagging
  // keeps the brief's exact counts and structure intact instead.
  const optSteps = (tag: string) => [
    { event: `$page-${tag}` },
    { event: `signed_up-${tag}` },
    { event: `subscription_started-${tag}` },
    { event: `video_submitted-${tag}`, optional: true },
    { event: `subscription_canceled-${tag}` },
  ]
  const runOpt = (steps: object[], extra: object = {}) =>
    preview({ steps, window_seconds: WINDOW, ...extra })

  it('counts someone who skipped the optional step as converted', async () => {
    // THE fixture. Under the old semantics this person is pinned at level 3
    // and never reaches step 5. Make the compiler treat an optional step as
    // required and exactly this test fails.
    const tag = 'skip'
    await journey('skip', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `subscription_canceled-${tag}`,
    ])
    const r = await runOpt(optSteps(tag))
    expect(r.converted).toBe(1)
    expect(r.steps[4].people).toBe(1)
    expect(r.steps[3].people).toBe(0)
    expect(r.steps[3].skipped).toBe(1)
  })

  it('counts someone who did the optional step at both the step and the end', async () => {
    const tag = 'both'
    await journey('both', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `video_submitted-${tag}`,
      `subscription_canceled-${tag}`,
    ])
    const r = await runOpt(optSteps(tag))
    expect(r.converted).toBe(1)
    expect(r.steps[3].people).toBe(1)
    expect(r.steps[3].skipped).toBe(0)
  })

  it('counts someone who did the optional step and stopped there', async () => {
    const tag = 'stall'
    await journey('stall', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `video_submitted-${tag}`,
    ])
    const r = await runOpt(optSteps(tag))
    expect(r.converted).toBe(0)
    expect(r.steps[3].people).toBe(1)
    expect(r.steps[2].people).toBe(1)
  })

  it('reports skipped as the branch point minus the step, on a mixed population', async () => {
    const tag = 'mix'
    await journey('m1', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `video_submitted-${tag}`,
    ])
    await journey('m2', [`$page-${tag}`, `signed_up-${tag}`, `subscription_started-${tag}`])
    await journey('m3', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `subscription_canceled-${tag}`,
    ])
    const r = await runOpt(optSteps(tag))
    expect(r.steps[2].people).toBe(3)
    expect(r.steps[3].people).toBe(1)
    expect(r.steps[3].skipped).toBe(2)
    // Exact by construction, never clamped. A negative here is a defect.
    expect(r.steps[3].skipped).toBeGreaterThanOrEqual(0)
  })

  it('rates the step after the optional one against the required step before it', async () => {
    const tag = 'rate'
    await journey('r1', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `subscription_canceled-${tag}`,
    ])
    await journey('r2', [`$page-${tag}`, `signed_up-${tag}`, `subscription_started-${tag}`])
    const r = await runOpt(optSteps(tag))
    // 1 of the 2 at subscription_started -- NOT 1 of the 0 at video_submitted.
    expect(r.steps[4].from_previous).toBeCloseTo(0.5)
  })

  it('does not count an optional event that arrives before its branch point', async () => {
    const tag = 'early'
    await journey('early', [
      `$page-${tag}`,
      `video_submitted-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `subscription_canceled-${tag}`,
    ])
    const r = await runOpt(optSteps(tag))
    expect(r.steps[3].people).toBe(0)
    expect(r.steps[3].skipped).toBe(1)
    expect(r.converted).toBe(1)
  })

  it('counts an optional event exactly at the window edge and not one past it', async () => {
    // The boundary instant in BOTH directions -- where a `>` / `>=`
    // divergence lives, and the fixture a suite naturally avoids.
    const tag = 'edge'
    const w = 600
    await journey('edge', [
      [`$page-${tag}`, 0],
      [`signed_up-${tag}`, 1_000],
      [`subscription_started-${tag}`, 2_000],
      [`video_submitted-${tag}`, w * 1000],
    ])
    await journey('past', [
      [`$page-${tag}`, 0],
      [`signed_up-${tag}`, 1_000],
      [`subscription_started-${tag}`, 2_000],
      [`video_submitted-${tag}`, w * 1000 + 1],
    ])
    const r = await runOpt(optSteps(tag), { window_seconds: w })
    expect(r.steps[3].people).toBe(1)
    expect(r.steps[3].skipped).toBe(1)
  })

  it('measures two adjacent optional steps independently off the same required step', async () => {
    const two = [
      { event: '$page-adj' },
      { event: 'signed_up-adj' },
      { event: 'video_submitted-adj', optional: true },
      { event: 'avatar_set-adj', optional: true },
      { event: 'subscription_started-adj' },
    ]
    await journey('vid', [
      '$page-adj',
      'signed_up-adj',
      'video_submitted-adj',
      'subscription_started-adj',
    ])
    await journey('avt', [
      '$page-adj',
      'signed_up-adj',
      'avatar_set-adj',
      'subscription_started-adj',
    ])
    const r = await runOpt(two)
    expect(r.steps[2].people).toBe(1)
    expect(r.steps[3].people).toBe(1)
    expect(r.steps[2].skipped).toBe(1)
    expect(r.steps[3].skipped).toBe(1)
    expect(r.converted).toBe(2)
  })

  it('serves the reached and skipped people lists as complements', async () => {
    // `/people` is keyed on a STORED funnel, so this one cannot go through
    // `preview` -- create it, then ask.
    const tag = 'complement'
    await journey('did', [
      `$page-${tag}`,
      `signed_up-${tag}`,
      `subscription_started-${tag}`,
      `video_submitted-${tag}`,
    ])
    await journey('didnt', [`$page-${tag}`, `signed_up-${tag}`, `subscription_started-${tag}`])
    const created = await app.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
      payload: {
        name: 'optional complements',
        steps: optSteps(tag),
        window_seconds: WINDOW,
      } as never,
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id

    const ask = async (mode: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/funnels/${id}/people`,
        headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
        payload: { step: 4, mode, ...RANGE } as never,
      })
      expect(res.statusCode).toBe(200)
      return res.json()
    }
    const reached = await ask('reached')
    const skipped = await ask('skipped')
    expect(reached.person_count).toBe(1)
    expect(skipped.person_count).toBe(1)
    const ids = new Set(
      [...reached.members, ...skipped.members].map((m: { person_id: string }) => m.person_id),
    )
    expect(ids.size).toBe(2)
  })
})
