import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'

/**
 * One suppression rule, five read paths that must agree on it — but only
 * three `notSuppressedExpr` (@lyraflow/core/privacy/suppression.ts) call
 * sites, not five, and one Postgres derivation independent of all three.
 *
 * The three ClickHouse, dictionary-side call sites:
 *   - the base population (compile.ts), compared against a PERSON-LEVEL
 *     `last_seen` — derived from device_index, pre-aggregated per (device,
 *     month), so exact only once the purge has run (compile.ts's own
 *     comment documents the "typically minutes" window that follows).
 *     Segment count and segment members BOTH compile through this CTE —
 *     `compileSegment`'s `select` argument (compile.ts) gates only the
 *     cursor clause, the projection, and the tail, never which CTEs get
 *     built.
 *   - the behavioural pass (behaviour.ts), compared per-event against each
 *     row's own `timestamp` — exact throughout. Segment count and segment
 *     members BOTH compile this CTE too, whenever the filter carries a
 *     behavioural node — which is why this file's own `countFor`/
 *     `membersFor` each issue both shapes below: `presenceFilter` hits the
 *     base population, `windowProbeFilter` hits the behavioural pass.
 *     compile.ts and behaviour.ts are two LAYERS of one path, not two
 *     separate paths.
 *   - the events feed (events/routes.ts), also compared per-event against
 *     each row's own `timestamp` — exact throughout, the identical shape
 *     the behavioural pass uses.
 *
 * The one Postgres derivation, `SuppressionStore.boundaryFor`
 * (privacy/suppression-store.ts) — checked directly against Postgres, at
 * zero replication lag, exact throughout — is used independently by the
 * person read (identity/person.ts) and the export (privacy/export.ts).
 *
 * Plan 4's final review found a guardrail that held on one route and not
 * its neighbour, a defect no per-task review could see because each diff
 * was correct against its own brief. This file is the guard against that
 * shape recurring, and what it actually proves is narrower than "five
 * independent copies agree": that the dictionary-side and Postgres-side
 * derivations agree with each other, and that the two ClickHouse `instant`
 * shapes — per-event and person-level `last_seen` — agree with each other
 * wherever both are exact. One fixture, one assertion body, run against all
 * five routes through their real HTTP surface (never compileSegment/
 * runSegment directly — an earlier task routed around the segment route
 * specifically to dodge its 30s result cache, and exercising that cache for
 * real is the point of this file).
 */

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
// this process's host-mapped localhost:5433. Same pattern as every other
// live-service suite in this package (person.test.ts, export.test.ts, ...).
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const SLUG = 'read-paths-test'
const WRITE_KEY = 'wk_read_paths'
const SERVER_KEY = 'sk_read_paths'

let app: FastifyInstance
let projectId: number

// Fixture ids picked so they cannot collide with any other privacy test
// file's own fixtures (person.test.ts's 'boundary-person'/'fully-erased',
// export.test.ts's 'exp-*', routes.test.ts's 'priv-scope-*').
const STRADDLER = 'rp-straddler'
const FULLY_ERASED = 'rp-fully-erased'
const UNTOUCHED = 'rp-untouched'
const SUBSECOND = 'rp-subsecond'
const ALL_IDS = [STRADDLER, FULLY_ERASED, UNTOUCHED, SUBSECOND]

// Anchored to the run, not an absolute date: the ingest clamp is irrelevant
// here (every event below is written straight to ClickHouse, bypassing it),
// but a suppressed_persons row IS still relative — and this suite has gone
// red mid-afternoon before over exactly this (see person.test.ts's BASE_MS
// docstring for the incident). NOW is captured once so every offset below,
// and every assertion against it, agrees for the life of this file's run.
//
// Deliberately NOT floored to a whole second. `suppressed_at` is Postgres
// `now()` at deletion time and almost always carries a fractional second; an
// earlier version of this file floored `NOW` to work around a real
// dictionary defect (`suppressed_persons` used to declare `suppressed_at
// DateTime` — second precision — so ClickHouse silently floored any
// sub-second component on load, measured directly against a live server).
// That defect is now fixed at its source (dictionaries.ts declares
// `DateTime64(6)`), so this file no longer needs to route around it — and
// keeping a raw, millisecond-bearing `NOW` is what proves the fix rather
// than hiding whether it is still needed.
const NOW = Date.now()
const hoursAgo = (h: number) => NOW - h * 3_600_000
const chStamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
const isoStamp = (ms: number) => new Date(ms).toISOString()

// straddler: two events before their boundary, one after — the shape the
// brief names directly ("a person with two erased events and one surviving
// one"), and the one case that discriminates a per-event filter from a
// person-level one. Plus one event landing EXACTLY on the boundary instant
// (see T_S_BOUNDARY below) — the case a per-task review found untested: the
// ClickHouse side treats `timestamp <= suppressed_at` as suppressed, the
// Postgres side treats `timestamp > suppressed_at` as kept, and the only
// thing making those two complements is that both were written that way. A
// fixture with no event AT the boundary cannot catch either side drifting
// to the wrong side of that inequality by one instant.
const T_S1 = hoursAgo(6) // $identify — erased
const T_S2 = hoursAgo(5) // rp_event  — erased
const T_S3 = hoursAgo(1) // rp_event  — survives
const BOUNDARY_STRADDLER = new Date(hoursAgo(3))
const T_S_BOUNDARY = BOUNDARY_STRADDLER.getTime() // rp_event — exactly on the boundary, erased

// fully-erased: both events sit before their own (separate) boundary, so
// the whole person disappears. Also gets its own boundary-instant event, for
// the same reason straddler does.
const T_F1 = hoursAgo(10) // $identify — erased
const T_F2 = hoursAgo(9) // rp_event   — erased
const BOUNDARY_FULLY_ERASED = new Date(hoursAgo(8))
const T_F_BOUNDARY = BOUNDARY_FULLY_ERASED.getTime() // rp_event — exactly on the boundary, erased

// untouched: never suppressed at all.
const T_U1 = hoursAgo(2.5) // $identify
const T_U2 = hoursAgo(1.5) // rp_event

// subsecond: the precision defect itself, not just the exact-instant case
// above. `suppressed_at` is Postgres `now()` at deletion time, so it almost
// always carries a fractional second — this person's boundary is built with
// one explicitly (`+777` below), independent of NOW's own arbitrary
// millisecond, so the gap this tests is a fixed, sizeable 777ms rather than
// whatever fraction of a second NOW happened to land on. One event sits
// strictly BETWEEN the truncated (whole-second-floored) instant a `DateTime`
// dictionary attribute used to report and the TRUE boundary Postgres holds —
// exactly the window where the ClickHouse-side paths used to disagree with
// the exact Postgres-side ones about whether an event that genuinely
// predates the deletion request is suppressed.
const secondFloor = (ms: number) => Math.floor(ms / 1000) * 1000
const SUBSECOND_BOUNDARY_MS = secondFloor(hoursAgo(2)) + 777
const BOUNDARY_SUBSECOND = new Date(SUBSECOND_BOUNDARY_MS)
const T_SUB_IDENTIFY = hoursAgo(7) // $identify — hours clear of any ambiguity, always erased
const T_SUB_GAP = SUBSECOND_BOUNDARY_MS - 300 // rp_event — inside the truncation gap, always erased

// A single reference point strictly between every erased timestamp and every
// surviving one (T_S1, T_S2, T_F1, T_F2 all fall before it; T_S3, T_U1, T_U2
// all fall after it) — independent of any individual person's own
// suppressed_at. Used only by the "never shows an event at or before the
// boundary" assertion, as a sanity check that a leaked timestamp cannot
// coincidentally land on the correct side by construction.
const CUTOFF_MS = hoursAgo(4)

// The exact set of instants any of the five paths may legitimately reveal.
// Real timestamps, not counts — a path returning the right NUMBER of events
// from the wrong side of the boundary fails this exact-set comparison the
// same way a path returning the wrong timestamps outright would. Deliberately
// excludes T_S_BOUNDARY/T_F_BOUNDARY: an event stamped exactly at a person's
// own boundary is erased, not kept, on both sides of the feature.
const EXPECTED_SURVIVING = new Set([T_S3, T_U1, T_U2])

// The two instants that must never appear in ANY path's eventTimestamps —
// checked by their own dedicated test below, separately from the general
// exact-set comparison above, so a failure here reads unambiguously as "an
// on-the-boundary event leaked" rather than as one line in a larger diff.
const BOUNDARY_INSTANTS = new Set([T_S_BOUNDARY, T_F_BOUNDARY])

/**
 * Cleans every table this file writes, at the TOP of beforeAll as well as in
 * afterAll — deleting from `events` alone does not remove rows a
 * materialised view already propagated into `device_index`/`person_traits`,
 * and a run that died mid-suite would otherwise leave this project's rows
 * there for the next run to trip over. Looked up by slug first, not the
 * `projectId` variable, for the same reason: a dead prior run's id is not
 * this run's `projectId`.
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
  // suppressed_persons cascades from `projects` (005_suppression.sql), so it
  // needs no cleanup call of its own.
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

async function insertEvent(opts: {
  userId: string
  eventName: string
  timestampMs: number
  properties?: Record<string, string>
}): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: randomUUID(),
        anonymous_id: '',
        user_id: opts.userId,
        event_name: opts.eventName,
        timestamp: chStamp(opts.timestampMs),
        received_at: chStamp(opts.timestampMs),
        trusted: 0,
        properties: opts.properties ?? {},
        properties_num: {},
      },
    ],
  })
}

/**
 * Writes the Postgres boundary and reloads the ClickHouse dictionary
 * immediately — there is no deletion endpoint call in this file to do that
 * reload for us (Task 6's route is not exercised here), so it has to happen
 * by hand, same as routes.test.ts's own `suppress()`.
 */
async function suppress(personId: string, at: Date): Promise<void> {
  await pg.query(
    'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,$3)',
    [projectId, personId, at],
  )
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  const inserted = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Read Paths', $1, $2, $3) RETURNING id`,
    [SLUG, WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(inserted.rows[0]?.id)

  await ensureIdentityDictionaries(ch, pgSource)

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

  // Every event carries its own user_id (no anonymous_id/device involved),
  // so identity resolution short-circuits on stage 1 and needs nothing from
  // identity_bindings/person_aliases — this fixture has no bindings to
  // reload. `rp_probe` is a trait unique per person, used below to pick one
  // fixture person out of the population without an AST node for person_id
  // (there deliberately is none — see compile.ts's own docstring).
  await insertEvent({
    userId: STRADDLER,
    eventName: '$identify',
    timestampMs: T_S1,
    properties: { rp_probe: STRADDLER },
  })
  await insertEvent({ userId: STRADDLER, eventName: 'rp_event', timestampMs: T_S2 })
  await insertEvent({ userId: STRADDLER, eventName: 'rp_event', timestampMs: T_S3 })
  await insertEvent({ userId: STRADDLER, eventName: 'rp_event', timestampMs: T_S_BOUNDARY })

  await insertEvent({
    userId: FULLY_ERASED,
    eventName: '$identify',
    timestampMs: T_F1,
    properties: { rp_probe: FULLY_ERASED },
  })
  await insertEvent({ userId: FULLY_ERASED, eventName: 'rp_event', timestampMs: T_F2 })
  await insertEvent({ userId: FULLY_ERASED, eventName: 'rp_event', timestampMs: T_F_BOUNDARY })

  await insertEvent({
    userId: UNTOUCHED,
    eventName: '$identify',
    timestampMs: T_U1,
    properties: { rp_probe: UNTOUCHED },
  })
  await insertEvent({ userId: UNTOUCHED, eventName: 'rp_event', timestampMs: T_U2 })

  await insertEvent({
    userId: SUBSECOND,
    eventName: '$identify',
    timestampMs: T_SUB_IDENTIFY,
    properties: { rp_probe: SUBSECOND },
  })
  await insertEvent({ userId: SUBSECOND, eventName: 'rp_event', timestampMs: T_SUB_GAP })

  await suppress(STRADDLER, BOUNDARY_STRADDLER)
  await suppress(FULLY_ERASED, BOUNDARY_FULLY_ERASED)
  await suppress(SUBSECOND, BOUNDARY_SUBSECOND)
  // UNTOUCHED gets no suppressed_persons row at all.
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

function preview(body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/segments/preview',
    headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
    payload: body as never,
  })
}

function getPerson(id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY },
  })
}

function exportReq(id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}/export`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY },
  })
}

/** NDJSON body -> parsed objects, one per line. Same shape as export.test.ts's own. */
function parseLines(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

/**
 * GET /v1/events over the whole fixture window. `since` is passed explicitly
 * — the route's own default is 24h before the REQUEST's `now`, not this
 * file's `NOW`, and every fixture event sits within 10 hours of `NOW`
 * (T_F1, the oldest, is `hoursAgo(10)`), so a naive omission would happen to
 * pass today but silently stop asserting anything the moment this suite's
 * own fixture offsets grew past 24h. `hoursAgo(24)` leaves 14 hours of
 * margin under the oldest fixture event, and `limit` covers every one of the
 * eleven events `beforeAll` inserts with room to spare.
 */
function eventsFeed(query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString()
  return app.inject({
    method: 'GET',
    url: `/v1/events?${qs}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY },
  })
}

/** The normalised shape every path's helper returns — see the file's own docstring. */
interface Snapshot {
  personIds: Set<string>
  eventTimestamps: Set<number>
}

function presenceFilter(id: string) {
  return { kind: 'trait', key: 'rp_probe', operator: '=', value: id }
}

/**
 * "Did THIS person have an event inside this exact one-second window" — the
 * technique the brief asks for where a path cannot report per-event
 * timestamps directly (segment count), and used for segment members too:
 * that path's own first_seen/last_seen are the RAW, unfiltered base
 * aggregate (compile.ts's own docstring: accurate typically within minutes
 * of the purge, not exact), so trusting them here would test a guarantee
 * this system does not make. A behavioural absolute window is exact
 * regardless, because it re-derives its answer from a single pass over
 * `events` with the per-event suppression clause applied (behaviour.ts).
 *
 * Windows are 1 second wide and every fixture timestamp is at least 30
 * minutes from its neighbours, so each window can only ever match the one
 * event it was built for.
 */
function windowProbeFilter(owner: string, atMs: number) {
  return {
    kind: 'group',
    op: 'and',
    children: [
      presenceFilter(owner),
      {
        kind: 'behavior',
        event: '*',
        aggregate: 'count',
        operator: '>=',
        value: 1,
        window: { kind: 'absolute', from: isoStamp(atMs), to: isoStamp(atMs + 1000) },
      },
    ],
  }
}

const PROBES: Array<{ owner: string; atMs: number }> = [
  { owner: STRADDLER, atMs: T_S1 },
  { owner: STRADDLER, atMs: T_S2 },
  { owner: STRADDLER, atMs: T_S3 },
  { owner: STRADDLER, atMs: T_S_BOUNDARY },
  { owner: FULLY_ERASED, atMs: T_F1 },
  { owner: FULLY_ERASED, atMs: T_F2 },
  { owner: FULLY_ERASED, atMs: T_F_BOUNDARY },
  { owner: UNTOUCHED, atMs: T_U1 },
  { owner: UNTOUCHED, atMs: T_U2 },
  { owner: SUBSECOND, atMs: T_SUB_GAP },
]

const countFor = async (): Promise<Snapshot> => {
  const personIds = new Set<string>()
  for (const id of ALL_IDS) {
    const res = await preview({ ast_version: 1, filter: presenceFilter(id) })
    expect(res.statusCode).toBe(200)
    if ((res.json().person_count as number) >= 1) personIds.add(id)
  }
  const eventTimestamps = new Set<number>()
  for (const probe of PROBES) {
    const res = await preview({
      ast_version: 1,
      filter: windowProbeFilter(probe.owner, probe.atMs),
    })
    expect(res.statusCode).toBe(200)
    if ((res.json().person_count as number) >= 1) eventTimestamps.add(probe.atMs)
  }
  return { personIds, eventTimestamps }
}

const membersFor = async (): Promise<Snapshot> => {
  const personIds = new Set<string>()
  for (const id of ALL_IDS) {
    const res = await preview({
      ast_version: 1,
      filter: presenceFilter(id),
      include: ['members'],
    })
    expect(res.statusCode).toBe(200)
    const members = res.json().members as Array<{ person_id: string }>
    if (members.some((m) => m.person_id === id)) personIds.add(id)
  }
  const eventTimestamps = new Set<number>()
  for (const probe of PROBES) {
    const res = await preview({
      ast_version: 1,
      filter: windowProbeFilter(probe.owner, probe.atMs),
      include: ['members'],
    })
    expect(res.statusCode).toBe(200)
    const members = res.json().members as Array<{ person_id: string }>
    if (members.length > 0) eventTimestamps.add(probe.atMs)
  }
  return { personIds, eventTimestamps }
}

const personFor = async (): Promise<Snapshot> => {
  const personIds = new Set<string>()
  const eventTimestamps = new Set<number>()
  for (const id of ALL_IDS) {
    const res = await getPerson(id)
    if (res.statusCode === 200) {
      personIds.add(id)
      const body = res.json()
      eventTimestamps.add(new Date(body.first_seen as string).getTime())
      eventTimestamps.add(new Date(body.last_seen as string).getTime())
    } else {
      expect(res.statusCode).toBe(404)
    }
  }
  return { personIds, eventTimestamps }
}

const exportFor = async (): Promise<Snapshot> => {
  const personIds = new Set<string>()
  const eventTimestamps = new Set<number>()
  for (const id of ALL_IDS) {
    const res = await exportReq(id)
    if (res.statusCode === 200) {
      personIds.add(id)
      for (const line of parseLines(res.body)) {
        if (line.type === 'event') {
          eventTimestamps.add(new Date(line.timestamp as string).getTime())
        }
      }
    } else {
      expect(res.statusCode).toBe(404)
    }
  }
  return { personIds, eventTimestamps }
}

/**
 * The feed normalises differently from the other four paths: it has no
 * per-id lookup, so this makes one project-wide call over the fixture
 * window and derives both sets from whichever rows come back, rather than
 * probing ALL_IDS/PROBES one at a time. `personIds` is each row's `user_id`
 * (falling back to `anonymous_id`) — every fixture event carries its own
 * `user_id` and an empty `anonymous_id` (`insertEvent`'s hard-coded ''), so
 * this fixture never exercises the fallback for real, and never exercises
 * identity resolution either: the feed returns each row's raw `user_id`
 * unresolved, where the other four paths report a *resolved* person id.
 * They agree here only because this fixture's ids never merge (see
 * `beforeAll`'s own "identity resolution short-circuits on stage 1"
 * comment) — a fixture with a merged device would be able to tell those
 * apart, and this one cannot.
 */
const eventsFeedFor = async (): Promise<Snapshot> => {
  const res = await eventsFeed({ since: isoStamp(hoursAgo(24)), limit: '100' })
  expect(res.statusCode).toBe(200)
  const body = res.json() as {
    events: Array<{ user_id: string; anonymous_id: string; timestamp: string }>
  }
  const personIds = new Set<string>()
  const eventTimestamps = new Set<number>()
  for (const e of body.events) {
    // Loud, not silent: this fixture's own beforeAll only ever inserts
    // events carrying a real user_id (no anonymous_id/device involved — see
    // that comment), so every row this project can legitimately return
    // should have one too. If that ever stops being true — an anonymous or
    // merged fixture person added to ALL_IDS — this row's personIds would
    // silently start reporting raw device/anonymous ids instead of the
    // resolved person id the other four paths report (this function's own
    // docstring above), and a suppressed person's leaked history could hide
    // behind a device id the "hides a person" assertion never checks for.
    // Failing here, immediately, turns that into an error that names its
    // own cause instead of a matrix row that quietly asserts nothing. Leak-
    // triggered, not fixture-triggered: an anonymous person whose whole
    // history stays suppressed never reaches this loop at all (the route's
    // own suppression check hides them before this test ever sees a row for
    // them), so this only fires for an anonymous person with a SURVIVING
    // event — either a new fixture person added without a real user_id, or
    // suppression failing to hide one that should have stayed hidden. The
    // message names both, since either reading is honest without more
    // context, and carries the anonymous_id so the offending row is findable.
    expect(
      e.user_id,
      `feed row has an empty user_id (anonymous_id=${e.anonymous_id}) — either this fixture gained an anonymous/merged person, or suppression let an anonymous person's history leak through`,
    ).not.toBe('')
    const id = e.user_id || e.anonymous_id
    if (id) personIds.add(id)
    eventTimestamps.add(new Date(e.timestamp).getTime())
  }
  return { personIds, eventTimestamps }
}

describe.each([
  ['segment count', countFor],
  ['segment members', membersFor],
  ['person read', personFor],
  ['export', exportFor],
  ['events feed', eventsFeedFor],
] as const)('%s', (_name, run) => {
  it('hides a person whose whole history predates the boundary', async () => {
    const snap = await run()
    expect(snap.personIds.has(FULLY_ERASED)).toBe(false)
  })

  it('shows a person who returned after the boundary', async () => {
    const snap = await run()
    expect(snap.personIds.has(STRADDLER)).toBe(true)
  })

  // Compares actual timestamps, not a count — see this file's own docstring
  // and the brief's "easier way to pass" warning. Exact set equality, not a
  // subset check: an extra (erased) timestamp fails this the same way a
  // missing (surviving) one does, and an implementation that dropped every
  // event would produce an empty set, which also fails — the failure mode a
  // bare "no erased timestamp present" loop over zero elements could not
  // catch.
  it('never shows an event at or before the boundary', async () => {
    const snap = await run()
    for (const ts of snap.eventTimestamps) {
      expect(ts).toBeGreaterThan(CUTOFF_MS)
    }
    expect(snap.eventTimestamps).toEqual(EXPECTED_SURVIVING)
  })

  it('leaves an undeleted person untouched', async () => {
    const snap = await run()
    expect(snap.personIds.has(UNTOUCHED)).toBe(true)
  })

  // THE test a fixture with no boundary-instant event cannot make possible.
  // ClickHouse's notSuppressedExpr treats `instant <= suppressed_at` as
  // suppressed; Postgres's paths keep on strict `instant > suppressed_at`.
  // Those are complements only because both were written that way — a
  // one-instant drift on either side (`<=` -> `<`, or `>` -> `>=`) is exactly
  // the "guardrail holds on one route and not its neighbour" shape this file
  // exists to catch, and it is invisible to every other assertion above,
  // which never places an event exactly on a boundary.
  it('hides an event landing exactly on the boundary instant', async () => {
    const snap = await run()
    for (const ts of BOUNDARY_INSTANTS) {
      expect(snap.eventTimestamps.has(ts)).toBe(false)
    }
  })

  // THE divergence test: a boundary that carries milliseconds (as every real
  // one does — suppressed_at is Postgres now()), with an event sitting in
  // the sub-second gap between the true boundary and the whole second a
  // `DateTime`-typed dictionary attribute used to floor it to. Before the
  // suppressed_persons dictionary declared `suppressed_at DateTime64(6)`
  // (dictionaries.ts), this person's own last-seen event (the gap event, the
  // later of their two) compared as AFTER the truncated boundary on the
  // ClickHouse side — visible via segment count/members — while the exact
  // Postgres-side boundary correctly kept it hidden on person read/export.
  // All five must agree the person is gone.
  it('hides a person whose only recent event sits in a truncated boundary sub-second gap', async () => {
    const snap = await run()
    expect(snap.personIds.has(SUBSECOND)).toBe(false)
  })
})
