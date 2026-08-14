import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

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

  /**
   * The level one specific person reached, read THROUGH the product.
   *
   * Deliberately not a hand-written windowFunnel query against ClickHouse:
   * that would prove my SQL agrees with itself and nothing about the engine.
   * A person appears in exactly one drop-off list — the level they stopped at
   * — so walking the levels through the real endpoint both isolates the
   * person and exercises the code under test.
   */
  async function levelOf(personId: string, overrides: object = {}): Promise<number> {
    for (let step = 1; step <= STEPS.length; step++) {
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
