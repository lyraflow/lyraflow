import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import type { Authenticate } from '../auth/bridge.js'
import { hashServerKey } from '../auth/project-cache.js'
import type { Project } from '../auth/project-cache.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from './dictionaries.js'
import { MAX_PERSON_RANGE_CLAUSES, type PersonDeps, registerPersonRoutes } from './person.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
// Resolved by the ClickHouse *server* itself, inside docker-compose.test.yml's
// own network — not this test process's host-mapped localhost:5433. Same
// pattern as resolve.test.ts and dictionaries.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

let app: FastifyInstance
let config: Config

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG_A = 'person-routes-test-a'
const SLUG_B = 'person-routes-test-b'
const WRITE_KEY_A = 'wk_person_routes_a'
const SERVER_KEY_A = 'sk_person_routes_a'
const WRITE_KEY_B = 'wk_person_routes_b'
const SERVER_KEY_B = 'sk_person_routes_b'

/**
 * Fixtures are anchored to the current run, not to absolute dates.
 *
 * The ingest path clamps a client timestamp older than MAX_CLOCK_SKEW_MS
 * (24h) to now-24h, so hardcoded dates silently expire: this suite was green
 * in the morning and began failing the same afternoon as wall-clock crossed
 * the boundary, with the clamped value substituted for the fixture's own.
 * Anchoring to `now` keeps every fixture inside the window on every run.
 *
 * Six hours back, so the spread of offsets below stays comfortably inside
 * the 24h window even for a long test run.
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000

/** ClickHouse DateTime64(3) literal, for direct inserts (bypasses the clamp). */
const chAt = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString().replace('T', ' ').replace('Z', '')

/** ISO-8601, for payloads sent through the HTTP ingest path (subject to the clamp). */
const isoAt = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString()

let projectA: number
let projectB: number

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  projectA = await makeProject(SLUG_A, 'PersonRoutesA', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'PersonRoutesB', WRITE_KEY_B, SERVER_KEY_B)

  // Created and loaded ONCE, before any of this file's own bindings exist,
  // and never reloaded again below. This makes it *likely* the dictionary
  // stays unaware of ids this file binds later — LIFETIME(MIN 5 MAX 15)
  // refreshes on a background thread, and this file finishes in well under a
  // second — but "likely" is a timing assumption, not a guarantee: on a slow
  // CI host a refresh could land between an identify() and the read that
  // follows it. The dedicated "no dictionary reload" test below does not
  // rely on that assumption; it asserts the dictionary's actual answer via
  // dictGetOrDefault at the moment of the read, so it fails loudly instead of
  // silently passing if a refresh ever does land mid-test.
  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })

  config = loadConfig({
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
  await pg.query('DELETE FROM identity_bindings WHERE project_id = ANY($1)', [[projectA, projectB]])
  await pg.query('DELETE FROM person_aliases WHERE project_id = ANY($1)', [[projectA, projectB]])
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
  // ClickHouse has no per-file DROP/CASCADE the way Postgres does — see the
  // identical comment and reasoning in resolve.test.ts's afterAll.
  await ch.command({
    query: `ALTER TABLE events DELETE WHERE project_id IN (${projectA}, ${projectB})`,
  })
  await pg.end()
  await ch.close()
})

// Flushes IngestBuffer synchronously after every identify(): buffer.add()
// triggers a flush fire-and-forget (`void this.#flushBatch()`, see
// buffer.ts) once flushRows is crossed, so the 202 response can return
// before the identify event's own row has actually landed in ClickHouse.
// Every test below reads that event set right back out, so without this the
// events count each test asserts on would be racy — same reasoning as
// routes.test.ts's per-request `await app.deps.buffer.flush()`.
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

function aliasReq(serverKey: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/alias',
    headers: { 'x-lyraflow-server-key': serverKey, 'user-agent': UA },
    payload: body,
  })
}

function getPerson(id: string, headers: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}`,
    headers,
  })
}

/** Project A, server-key-authenticated — the deletion-boundary tests' own shorthand. */
function read(id: string) {
  return getPerson(id, { 'x-lyraflow-server-key': SERVER_KEY_A })
}

// Proves — rather than assumes from wall-clock timing — that the ClickHouse
// identity_bindings dictionary does not yet know about a device's binding at
// the moment of the read: queries the dictionary directly with a sentinel
// fallback no real person_id would ever equal, so getting the sentinel back
// means the dictionary has nothing for `anonymousId` (same
// dictGetOrDefault shape dictionaries.test.ts's own live probe uses).
async function dictionaryUnawareOf(projectId: number, anonymousId: string): Promise<boolean> {
  const sentinel = '__dict_bypass_probe_unbound__'
  const rs = await ch.query({
    query: `SELECT dictGetOrDefault('${CH_DB}.identity_bindings', 'person_id',
              (toUInt32(${projectId}), '${anonymousId}'), now(), '${sentinel}') AS person`,
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ person: string }>()
  return row?.person === sentinel
}

async function insertEvent(opts: {
  projectId: number
  anonymousId?: string
  userId?: string
  timestamp: string
  eventName: string
}): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: opts.projectId,
        event_id: randomUUID(),
        anonymous_id: opts.anonymousId ?? '',
        user_id: opts.userId ?? '',
        event_name: opts.eventName,
        timestamp: opts.timestamp,
        received_at: opts.timestamp,
        trusted: 0,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

describe('GET /v1/persons/:id', () => {
  // THE test for retroactive attachment — the product's premise (see the
  // task brief's "why this exists"). Would catch: querying only by the
  // resolved canonical id instead of the full canonical-plus-devices set
  // (the pre-identify event was recorded under the *anonymous* id, never the
  // user id); would catch dropping the `OR anonymous_id IN {ids}` half of
  // the WHERE clause entirely.
  it("includes an event sent under the person's anonymous_id before identify() was called", async () => {
    await insertEvent({
      projectId: projectA,
      anonymousId: 'retro-anon',
      timestamp: chAt(120),
      eventName: 'retro_pre_identify',
    })

    // The identify() call itself is also an event, recorded under this same
    // (anonymous_id, user_id) pair — given its own explicit, later timestamp
    // so first_seen/last_seen below are exact rather than racing wall-clock
    // `now`.
    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'retro-anon',
      user_id: 'retro-user',
      timestamp: isoAt(150),
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const personRes = await getPerson('retro-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    expect(body.person_id).toBe('retro-user')
    expect(body.ids.sort()).toEqual(['retro-anon', 'retro-user'])
    // 2, not 1: the pre-identify event this test is actually about, plus the
    // identify() call's own event (see the comment above it).
    expect(body.events).toBe(2)
    expect(body.first_seen).toBe(isoAt(120))
    expect(body.last_seen).toBe(isoAt(150))
  })

  // THE test for zero dictionary lag — the entire reason this endpoint
  // exists. The identity dictionaries were built and loaded in beforeAll,
  // *before* 'lag-anon'/'lag-user' existed anywhere, and are never reloaded
  // anywhere in this file. A dictGetOrDefault-based implementation (the
  // pattern resolve.ts uses for segment-wide reads) would therefore still
  // resolve 'lag-anon' to itself — the binding this test creates is
  // invisible to that stale dictionary — and this event would be missing
  // from the response, or the person_id/ids would come back wrong. Reading
  // straight from IdentityBindings/PersonAliases (Postgres) sees the write
  // immediately, with nothing to reload.
  //
  // The dictionaryUnawareOf() assertion below is the premise made explicit
  // and checked, not assumed from how fast this file happens to run: without
  // it, a background dictionary refresh landing between identify() and the
  // read (plausible on a slow CI host, since LIFETIME(MIN 5 MAX 15) is not
  // under this test's control) could silently make a dictGet-based
  // implementation pass anyway.
  it('reflects a binding made moments ago, without any dictionary reload', async () => {
    await insertEvent({
      projectId: projectA,
      anonymousId: 'lag-anon',
      timestamp: chAt(180),
      eventName: 'lag_pre_identify',
    })

    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'lag-anon',
      user_id: 'lag-user',
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    // The premise this test's name claims, checked rather than assumed: at
    // this exact moment, the ClickHouse dictionary still has no answer for
    // 'lag-anon' — no SYSTEM RELOAD DICTIONARY call has run since beforeAll.
    expect(await dictionaryUnawareOf(projectA, 'lag-anon')).toBe(true)

    const personRes = await getPerson('lag-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    // 2: the pre-identify event, plus the identify() call's own event.
    expect(body.events).toBe(2)
    expect(body.ids.sort()).toEqual(['lag-anon', 'lag-user'])
  })

  // THE test for the alias-group defect: /v1/alias only ever writes to
  // person_aliases, never repoints identity_bindings.person_id — so a device
  // bound to an id *before* it gets merged away stays bound to that old id
  // in Postgres forever. The fixture binds the device to 'alias-a' — the id
  // that is about to be merged AWAY — and records a second event directly
  // under user_id 'alias-a', both *before* the merge. Binding the device to
  // the survivor 'alias-b' instead (as an earlier version of this test did)
  // would make a buggy devicesForAny([canonical])-only implementation
  // indistinguishable from a correct one: both would already find the
  // device via the canonical alone, with no need to ever consult
  // person_aliases for who merged into it. Would catch: PersonAliases'
  // mergedFrom() being dropped from person.ts (or never called), which
  // leaves 'alias-a' and 'alias-device' out of `ids` entirely and — since
  // 'alias-b' has no events of its own — turns this into a 404 instead of a
  // 200 with the full merged history. Would also catch: skipping
  // canonicalFor() and computing the group from the raw path id instead of
  // its canonical.
  it("resolves an aliased id's pre-merge devices and events into the surviving canonical's profile", async () => {
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'alias-device',
      user_id: 'alias-a',
      timestamp: isoAt(180),
      traits: {},
    })
    await insertEvent({
      projectId: projectA,
      userId: 'alias-a',
      timestamp: chAt(210),
      eventName: 'alias_pre_merge_event',
    })

    const aliasRes = await aliasReq(SERVER_KEY_A, {
      from_user_id: 'alias-a',
      to_user_id: 'alias-b',
    })
    expect(aliasRes.statusCode).toBe(200)

    // Querying by the OLD id still resolves through canonicalFor to the
    // survivor's full merged profile.
    const byOldId = await getPerson('alias-a', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(byOldId.statusCode).toBe(200)
    const bodyByOldId = byOldId.json()
    expect(bodyByOldId.person_id).toBe('alias-b')
    expect(bodyByOldId.ids.sort()).toEqual(['alias-a', 'alias-b', 'alias-device'])
    // 2: the identify() call's own event (anonymous_id='alias-device',
    // user_id='alias-a'), plus the explicit alias_pre_merge_event recorded
    // directly under user_id='alias-a'.
    expect(bodyByOldId.events).toBe(2)
    expect(bodyByOldId.first_seen).toBe(isoAt(180))
    expect(bodyByOldId.last_seen).toBe(isoAt(210))

    // The reproduction from the review report: querying the SURVIVOR's own
    // id must return the identical, complete profile — not a 404, which is
    // exactly what 'alias-b' having no events of its own would previously
    // produce (devicesForAny([canonical]) alone finds nothing bound to
    // 'alias-b').
    const bySurvivorId = await getPerson('alias-b', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(bySurvivorId.statusCode).toBe(200)
    expect(bySurvivorId.json()).toEqual(bodyByOldId)
  })

  /**
   * Was: "counts a rebound device's whole history for BOTH people — the
   * documented divergence from event resolution", asserting the UNION
   * behaviour Plan 2 shipped deliberately (5/5 events for two people who
   * never overlapped on the device) and Plan 3 deferred converging. That
   * test was written to fail loudly the moment this convergence landed —
   * this is that landing.
   *
   * A device shared by two people now splits at the rebind: each profile
   * sees only the events that fell inside its own window, matching what
   * `resolvedPersonExpr` (resolve.ts) already does for event-wide reads.
   *
   * Person names are chosen so alphabetical and chronological order
   * disagree ('zed' bound first, 'amy' second) — see the suite's "Test
   * discipline" note on the previous task's ordering test passing for the
   * wrong reason because 'alice' happened to sort both ways at once. A
   * from/to mix-up here would show up as the wrong person getting which
   * count, not as a coincidentally-correct pass.
   */
  it('splits a rebound device history at the rebind, giving each person only their own', async () => {
    // 'rebind-zed' holds the device first, 'rebind-amy' after — written
    // straight to identity_bindings (bypassing /v1/identify) so the bind
    // instants land exactly on chAt/isoAt offsets rather than server receipt
    // time, which is what makes the "before/after the rebind" split
    // deterministic below.
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, 'rebind-device', 'rebind-zed', $2),
         ($1, 'rebind-device', 'rebind-amy', $3)`,
      [projectA, isoAt(700), isoAt(760)],
    )
    for (const timestamp of [chAt(710), chAt(730), chAt(780)]) {
      await insertEvent({
        projectId: projectA,
        anonymousId: 'rebind-device',
        timestamp,
        eventName: 'rebind_x',
      })
    }

    const auth = { 'x-lyraflow-server-key': SERVER_KEY_A }
    // 710 and 730 fall before the 760 rebind, so they are zed's; 780 falls
    // after, so it is amy's alone.
    expect((await getPerson('rebind-zed', auth)).json().events).toBe(2)
    expect((await getPerson('rebind-amy', auth)).json().events).toBe(1)
  })

  /**
   * The narrower half of the same defect, and the one a fix for the wider
   * half can reintroduce. An event carrying its own user_id belongs to that
   * person, even when it sits on a device bound to someone else — this
   * mirrors stage 1 of resolvedPersonExpr, which short-circuits on a
   * non-empty user_id.
   */
  it('gives an event carrying its own user_id to that person, not the device owner', async () => {
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       VALUES ($1, 'guard-device', 'guard-alice', $2)`,
      [projectA, isoAt(800)],
    )
    await insertEvent({
      projectId: projectA,
      anonymousId: 'guard-device',
      timestamp: chAt(810),
      eventName: 'guard_device_era',
    })
    await insertEvent({
      projectId: projectA,
      anonymousId: 'guard-device',
      userId: 'guard-bob',
      timestamp: chAt(820),
      eventName: 'guard_own_user_id',
    })

    const auth = { 'x-lyraflow-server-key': SERVER_KEY_A }
    expect((await getPerson('guard-alice', auth)).json().events).toBe(1)
    expect((await getPerson('guard-bob', auth)).json().events).toBe(1)
  })

  // Would catch: `bindEventsForDevices` querying identity_bindings by
  // anonymous_id alone, with no project_id filter — anonymous_id is
  // caller-supplied and carries no project qualifier of its own, so an
  // unscoped query can return another project's bind rows for a colliding
  // device id. Same style as the devicesForAny contention test below: both
  // projects bind the SAME device id ('contended-device') to a DIFFERENT
  // person, so a leak is a wrong window, not just a wrong id string.
  //
  // Project B binds first (offset 850), project A second (offset 900).
  // Project A alone gets a pre-A-bind event at offset 860 — after B's bind,
  // before A's own. Correctly scoped, project A's device has exactly ONE
  // bind ever, so its single tile is [-inf, +inf) and the offset-860 event
  // belongs to tenant-a-person by retroactive attachment. If
  // bindEventsForDevices leaked B's row into A's derivation, deriveTiling
  // would see two binds for 'contended-device' (B's at 850, A's at 900) and
  // split the timeline there — truncating tenant-a-person's tile to
  // [900, +inf) and silently dropping the offset-860 event from A's own
  // profile, undercounting rather than leaking B's literal data. That is
  // the observable failure this test pins.
  it("does not let a colliding device id absorb another project's binds or events", async () => {
    await identify(WRITE_KEY_B, {
      message_id: randomUUID(),
      anonymous_id: 'contended-device',
      user_id: 'tenant-b-person',
      timestamp: isoAt(850),
      traits: {},
    })
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'contended-device',
      user_id: 'tenant-a-person',
      timestamp: isoAt(900),
      traits: {},
    })
    await insertEvent({
      projectId: projectA,
      anonymousId: 'contended-device',
      timestamp: chAt(860),
      eventName: 'contended_pre_bind',
    })

    const resA = await getPerson('tenant-a-person', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(resA.statusCode).toBe(200)
    const bodyA = resA.json()
    // 2: the offset-860 pre-bind event, plus project A's own identify event
    // at offset 900. A count of 1 here (offset-860 event missing) is exactly
    // what an unscoped bindEventsForDevices produces.
    expect(bodyA.events).toBe(2)
    expect(bodyA.first_seen).toBe(isoAt(860))
    expect(bodyA.last_seen).toBe(isoAt(900))

    const resB = await getPerson('tenant-b-person', { 'x-lyraflow-server-key': SERVER_KEY_B })
    expect(resB.statusCode).toBe(200)
    // 1: project B's own identify event alone — unaffected either way, this
    // is the sanity check that project B's own profile stays correct too.
    expect(resB.json().events).toBe(1)
  })

  // The cap exists because a person's windows are devices multiplied by
  // rebinds, which has no fixed bound — reachable by anyone holding the
  // server key (see README's *Reading a person*). Would catch:
  // MAX_PERSON_RANGE_CLAUSES or the 400 it guards being deleted or bypassed
  // entirely, which — per the brief this task carries — is how the union
  // behaviour this whole convergence removes would silently come back for a
  // large enough person.
  //
  // Shape chosen deliberately: MAX_PERSON_RANGE_CLAUSES + 5 DISTINCT
  // devices, each bound exactly ONCE, all to 'fragmented-person', rather
  // than one device rebound many times. A device bound only once has
  // exactly one tile ([-inf, +inf), owned by that bind's person) — so N
  // such devices is exactly N windows, with no dependency on how many
  // tiles deriveTiling collapses a single device's rebind sequence into or
  // how many of those tiles land on this particular person. That keeps the
  // fixture's window count exact and independent of tiling internals.
  //
  // A single INSERT ... SELECT ... FROM unnest(), not one row per
  // `pg.query` call — this only needs to prove the cap trips, not exercise
  // the write path bind() itself (already covered elsewhere), and a loop of
  // 200+ round trips would make this test needlessly slow.
  //
  // This fixture is far larger than the rest of the file's, so it is
  // cleaned up immediately rather than left for afterAll — nothing else in
  // this file touches 'fragmented-person' or its devices, but there is no
  // reason to leave ~200 rows sitting in Postgres for the remainder of the
  // suite's run.
  it('refuses a person whose history is too fragmented to bound', async () => {
    const deviceIds = Array.from(
      { length: MAX_PERSON_RANGE_CLAUSES + 5 },
      (_, i) => `frag-device-${i}`,
    )
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       SELECT $1, d, 'fragmented-person', $3::timestamptz
       FROM unnest($2::text[]) AS d`,
      [projectA, deviceIds, isoAt(2000)],
    )

    try {
      const res = await getPerson('fragmented-person', { 'x-lyraflow-server-key': SERVER_KEY_A })
      expect(res.statusCode).toBe(400)
      // Exact body, not just the status: pins the error code and the
      // detail's actual window count (one per device, per the shape above),
      // not merely "some 400 happened".
      expect(res.json()).toEqual({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${deviceIds.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    } finally {
      await pg.query(
        `DELETE FROM identity_bindings WHERE project_id = $1 AND person_id = 'fragmented-person'`,
        [projectA],
      )
    }
  })

  // Would catch: sending `ids` straight from `[...group, ...devices]` without
  // deduping — identify({anonymous_id:'dup-id', user_id:'dup-id'}) makes
  // 'dup-id' both the canonical (via personId) and its own bound device, so
  // an undeduped implementation returns `['dup-id','dup-id']` here, which
  // fails the exact-array `toEqual` below (`.sort()` alone does not hide a
  // duplicate — `['dup-id','dup-id']` stays two elements after sorting).
  it('deduplicates ids when the anonymous_id and user_id coincide', async () => {
    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'dup-id',
      user_id: 'dup-id',
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const personRes = await getPerson('dup-id', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    expect(personRes.json().ids).toEqual(['dup-id'])
  })

  // THE test for `:id` being a DEVICE id, which README documents and which
  // every other lookup this route composes (canonicalFor, mergedFrom,
  // devicesForAny) is incapable of — all three are keyed on person_id.
  // Without IdentityBindings.mostRecentPersonFor, 'lookup-device' resolves
  // to itself and the route answers a plausible-looking, silently wrong 200:
  // person_id 'lookup-device', ids ['lookup-device'].
  //
  // Would catch exactly that. Note the events count is NOT what discriminates
  // here and deliberately is not relied on: both the correct and the
  // device-blind answer match the same two rows, because the WHERE clause
  // already covers anonymous_id. person_id and ids are the assertions that
  // fail when the lookup is removed.
  it('resolves a device id to the person it is bound to', async () => {
    await insertEvent({
      projectId: projectA,
      anonymousId: 'lookup-device',
      timestamp: chAt(540),
      eventName: 'device_lookup_pre',
    })
    const res = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'lookup-device',
      user_id: 'lookup-owner',
      timestamp: isoAt(570),
      traits: {},
    })
    expect(res.statusCode).toBe(202)

    const personRes = await getPerson('lookup-device', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    expect(body.person_id).toBe('lookup-owner')
    expect(body.ids.sort()).toEqual(['lookup-device', 'lookup-owner'])
    expect(body.events).toBe(2)
    expect(body.first_seen).toBe(isoAt(540))
    expect(body.last_seen).toBe(isoAt(570))
  })

  // The documented ambiguity: a device bound to more than one person over
  // time has no single right answer, and this route returns the most recent
  // binding — the device's current owner. Would catch: `ORDER BY bound_at
  // DESC` flipped to ASC, or dropped altogether and left to Postgres's
  // incidental row order, either of which can answer 'ambiguous-first'.
  // Would also catch a LIMIT-less query feeding a person id array into a
  // lookup that expects one.
  it('resolves a device bound to several people to its most recently bound one', async () => {
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'ambiguous-device',
      user_id: 'ambiguous-first',
      timestamp: isoAt(600),
      traits: {},
    })
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'ambiguous-device',
      user_id: 'ambiguous-second',
      timestamp: isoAt(660),
      traits: {},
    })

    const personRes = await getPerson('ambiguous-device', {
      'x-lyraflow-server-key': SERVER_KEY_A,
    })
    expect(personRes.statusCode).toBe(200)
    const body = personRes.json()
    expect(body.person_id).toBe('ambiguous-second')
    // 'ambiguous-first' is deliberately absent: it is a different person, not
    // an alias of the second, so it is not part of this person's id set. The
    // device is shared, so `ids` still names both — the assertion this test
    // is actually about is person_id/ids above, not events, which this route
    // now time-splits at the rebind (see the rebind-split test) rather than
    // double-counting for both profiles.
    expect(body.ids.sort()).toEqual(['ambiguous-device', 'ambiguous-second'])
  })

  // Would catch: gating this route on projects.byWriteKey (or accepting
  // either header) instead of exclusively projects.byServerKey.
  it('rejects the public write key with 401', async () => {
    const res = await getPerson('anyone', { 'x-lyraflow-write-key': WRITE_KEY_A })
    expect(res.statusCode).toBe(401)
  })

  // Would catch: the "no header at all" branch answering something other
  // than 401 — e.g. falling through to an unauthenticated ClickHouse query.
  it('rejects a request with no key at all with 401', async () => {
    const res = await getPerson('anyone', {})
    expect(res.statusCode).toBe(401)
  })

  // The positive-path complement to the two 401 tests above: proves a valid
  // server key is actually accepted, not just that the wrong/missing key is
  // rejected. Would catch: authenticateServer built with the wrong lookup
  // (e.g. one that only ever returns null), which the two negative tests
  // alone cannot distinguish from "server key correctly rejected too".
  it('succeeds with a valid server key', async () => {
    await insertEvent({
      projectId: projectA,
      userId: 'server-key-ok',
      timestamp: chAt(300),
      eventName: 'server_key_ok_event',
    })
    const res = await getPerson('server-key-ok', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(res.statusCode).toBe(200)
  })

  // Documents the 404-vs-empty-result decision: an id nothing has ever
  // recorded is "no such person", not a person with a zeroed-out profile.
  // Would catch: always answering 200 regardless of whether any event
  // matched.
  it('answers 404 for an id with no known events, bindings, or aliases', async () => {
    const res = await getPerson('never-seen-anywhere', {
      'x-lyraflow-server-key': SERVER_KEY_A,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'person_not_found' })
  })

  // THE test for project scoping, and specifically for a dropped project_id
  // filter in the ClickHouse query. Both projects are given genuine,
  // non-empty data under the identical user_id 'shared-user' — a version of
  // this test where project B were empty would pass even with project_id
  // dropped entirely (project A's own rows would still be the only ones
  // found by accident). With real contention, dropping project_id would
  // instead return a merged/wrong first_seen, last_seen, and events count —
  // this test pins the exact expected values for project A alone.
  it("does not leak another project's events for the same user_id", async () => {
    await insertEvent({
      projectId: projectA,
      userId: 'shared-user',
      timestamp: chAt(360),
      eventName: 'scope_a_event',
    })
    await insertEvent({
      projectId: projectB,
      userId: 'shared-user',
      timestamp: '2026-01-01 00:00:00.000',
      eventName: 'scope_b_event_1',
    })
    await insertEvent({
      projectId: projectB,
      userId: 'shared-user',
      timestamp: '2026-01-02 00:00:00.000',
      eventName: 'scope_b_event_2',
    })

    const resA = await getPerson('shared-user', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(resA.statusCode).toBe(200)
    const bodyA = resA.json()
    expect(bodyA.events).toBe(1)
    expect(bodyA.first_seen).toBe(isoAt(360))
    expect(bodyA.last_seen).toBe(isoAt(360))

    const resB = await getPerson('shared-user', { 'x-lyraflow-server-key': SERVER_KEY_B })
    expect(resB.statusCode).toBe(200)
    const bodyB = resB.json()
    expect(bodyB.events).toBe(2)
    expect(bodyB.first_seen).toBe('2026-01-01T00:00:00.000Z')
    expect(bodyB.last_seen).toBe('2026-01-02T00:00:00.000Z')
  })

  // THE test for project scoping on the two POSTGRES queries this route
  // composes — PersonAliases.mergedFrom and IdentityBindings.devicesForAny —
  // which the ClickHouse-scoping test above does not touch at all. It uses
  // 'shared-user', an id with no bindings and no aliases, so both Postgres
  // queries return empty for both projects and `project_id = $1` can be
  // deleted from either with the whole suite still green.
  //
  // That is not merely a wrong count. `ids` is returned to the caller
  // (person.ts's response body), so a dropped filter discloses ANOTHER
  // TENANT'S person and device ids inside a 200 response.
  //
  // The fixture puts the two projects in genuine contention on BOTH queries
  // at once. The two need contention of different shapes, and a fixture that
  // supplies only one of them leaves the other mutation green (confirmed the
  // hard way — an earlier version of this test contended only on mergedFrom,
  // and deleting devicesForAny's filter passed):
  //   - mergedFrom is keyed on canonical_id, so both projects merge into the
  //     SAME canonical ('shared-canonical') from DIFFERENT person ids
  //     ('tenant-a-old' vs 'tenant-b-old'). Reusing one person id across both
  //     projects would make an unscoped mergedFrom return the same string
  //     twice, which dedupes away and hides the leak entirely.
  //   - devicesForAny is keyed on person_id, so both projects must bind a
  //     device to a person id that is actually IN the queried group. Binding
  //     each project's device to its own merged-away id would not do it:
  //     'tenant-b-old' is never in project A's group, so B's device would
  //     stay invisible to A even unscoped. Both therefore bind a DIFFERENT
  //     device id to the SAME 'shared-canonical'.
  //
  // Verified by deleting `project_id = $1` from each query in turn:
  //   - aliases.ts mergedFrom      -> A's ids gain 'tenant-b-old'.
  //   - bindings.ts devicesForAny  -> A's ids gain 'tenant-b-device'.
  // Both fail the exact-array assertions below.
  it("does not leak another project's merged-away person ids or bound devices", async () => {
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: 'tenant-a-device',
      user_id: 'shared-canonical',
      timestamp: isoAt(420),
      traits: {},
    })
    await identify(WRITE_KEY_B, {
      message_id: randomUUID(),
      anonymous_id: 'tenant-b-device',
      user_id: 'shared-canonical',
      timestamp: isoAt(420),
      traits: {},
    })
    const mergedA = await aliasReq(SERVER_KEY_A, {
      from_user_id: 'tenant-a-old',
      to_user_id: 'shared-canonical',
    })
    expect(mergedA.statusCode).toBe(200)
    const mergedB = await aliasReq(SERVER_KEY_B, {
      from_user_id: 'tenant-b-old',
      to_user_id: 'shared-canonical',
    })
    expect(mergedB.statusCode).toBe(200)

    const resA = await getPerson('shared-canonical', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(resA.statusCode).toBe(200)
    const bodyA = resA.json()
    expect(bodyA.person_id).toBe('shared-canonical')
    // Exact array, not a `toContain` pair: only an exact comparison fails on
    // an EXTRA id appearing, which is the whole failure mode here.
    expect(bodyA.ids.sort()).toEqual(['shared-canonical', 'tenant-a-device', 'tenant-a-old'])
    // 1: project A's own identify event. Project B's identical-shaped event
    // stays out of the count too.
    expect(bodyA.events).toBe(1)

    const resB = await getPerson('shared-canonical', { 'x-lyraflow-server-key': SERVER_KEY_B })
    expect(resB.statusCode).toBe(200)
    const bodyB = resB.json()
    expect(bodyB.person_id).toBe('shared-canonical')
    expect(bodyB.ids.sort()).toEqual(['shared-canonical', 'tenant-b-device', 'tenant-b-old'])
    expect(bodyB.events).toBe(1)
  })

  // THE test for the main use case the cap exists to protect, not merely the
  // cap tripping. 'refuses a person whose history is too fragmented to
  // bound' above deliberately uses MAX_PERSON_RANGE_CLAUSES + 5 DISTINCT
  // devices, each bound once, specifically so it does not depend on tiling
  // internals — but that shape never occurs for the ordinary customer this
  // route serves. The real shape is the opposite: ONE device, ONE person,
  // rebound to the SAME person over and over — a logged-in browser's repeat
  // identify() on every page load (bindings.ts's GROWTH CHARACTERISTIC note:
  // every identified page load writes a bind row, and the omitted-timestamp
  // common case never collides on (device, instant), so it never
  // deduplicates). Without coalescing contiguous same-person windows before
  // the cap check, this many binds on ONE device produces this many windows,
  // and a customer who has simply viewed more than MAX_PERSON_RANGE_CLAUSES
  // pages while logged in gets a permanent 400 on their own profile.
  //
  // A single INSERT ... SELECT ... FROM unnest(), same reasoning as the
  // fragmentation test above: this only needs the bind rows to exist, not to
  // exercise bind() itself.
  it('does not fragment a person whose history is one device rebound to itself many times', async () => {
    const bindCount = MAX_PERSON_RANGE_CLAUSES + 5
    const timestamps = Array.from({ length: bindCount }, (_, i) => isoAt(5000 + i))
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       SELECT $1, 'repeat-identify-device', 'repeat-identify-person', t::timestamptz
       FROM unnest($2::text[]) AS t`,
      [projectA, timestamps],
    )
    // One real event, so a 200 has something non-zero to assert on rather
    // than merely the absence of a 400.
    await insertEvent({
      projectId: projectA,
      anonymousId: 'repeat-identify-device',
      timestamp: chAt(5500),
      eventName: 'repeat_identify_pre',
    })

    try {
      const res = await getPerson('repeat-identify-person', {
        'x-lyraflow-server-key': SERVER_KEY_A,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().events).toBe(1)
    } finally {
      await pg.query(
        `DELETE FROM identity_bindings WHERE project_id = $1 AND person_id = 'repeat-identify-person'`,
        [projectA],
      )
    }
  })

  // Half-open windows, [from, to), pinned at the actual boundary instant —
  // nothing else in this file sends an event stamped at EXACTLY a rebind's
  // own timestamp. Would catch either half-open bound flipped to closed at
  // the wrong end (the event landing in BOTH profiles, or NEITHER).
  it('assigns an event stamped at exactly a rebind instant to the incoming owner only', async () => {
    // Offsets kept inside the ingest clamp's 24h skew window (see isoAt's own
    // docstring on BASE_MS): identify() timestamps go through the public HTTP
    // path and clampTimestamp silently rewrites anything further than 24h
    // from server time, which would substitute a DIFFERENT instant than the
    // one asserted on below and defeat the whole test.
    const device = 'boundary-instant-device'
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: device,
      user_id: 'boundary-outgoing',
      timestamp: isoAt(700),
      traits: {},
    })
    await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: device,
      user_id: 'boundary-incoming',
      timestamp: isoAt(710),
      traits: {},
    })
    // Stamped at exactly offset 710, the rebind instant itself. Recorded
    // with no user_id of its own so it resolves purely through the device's
    // window (Stage 2), not Stage 1's user_id short-circuit.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chAt(710),
      eventName: 'boundary_instant_event',
    })

    const outgoing = await getPerson('boundary-outgoing', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(outgoing.statusCode).toBe(200)
    // 1: only its own identify event. Its window is [.., 710) — half-open —
    // so the boundary event at exactly offset 710 is NOT included.
    expect(outgoing.json().events).toBe(1)

    const incoming = await getPerson('boundary-incoming', { 'x-lyraflow-server-key': SERVER_KEY_A })
    expect(incoming.statusCode).toBe(200)
    // 2: its own identify event, plus the boundary event — its window is
    // [710, ..), which includes the boundary instant itself.
    expect(incoming.json().events).toBe(2)
  })

  // THE test for the deletion boundary itself, and for it taking effect with
  // NO dictionary reload and NO sleep — this route resolves suppression from
  // Postgres directly rather than the ClickHouse identity dictionary
  // (person.ts's SuppressionStore comment explains why: a 1-5s LIFETIME
  // would put identity lag back on the one path meant to be lag-free).
  //
  // Fixtures anchored to Date.now(), never absolute dates: the ingest path
  // clamps client timestamps older than 24h, so a pinned date expires on a
  // wall-clock schedule (this exact suite went red mid-afternoon on
  // 2026-08-07 with no code change) — see BASE_MS's own docstring.
  //
  // Four events, not three: base, base+1h, base+2h (EXACTLY the boundary
  // instant), base+3h. The boundary-instant event is what makes this test
  // discriminate a strict `>` comparison from `>=` — with only the other
  // three, both comparisons agree (none of them sits exactly on the
  // boundary), so a `>=` regression would pass unnoticed. See the mutation
  // proof below the SuppressionStore boundary code in person.ts, and Step 7
  // of this task's brief.
  it('hides events at or before the deletion boundary, immediately and without a reload', async () => {
    const base = Date.now() - 6 * 3_600_000
    const at = (offsetMs: number) =>
      new Date(base + offsetMs).toISOString().replace('T', ' ').replace('Z', '')
    const boundaryOffsetMs = 2 * 3_600_000

    for (const offsetMs of [0, 3_600_000, boundaryOffsetMs, 3 * 3_600_000]) {
      await insertEvent({
        projectId: projectA,
        userId: 'boundary-person',
        timestamp: at(offsetMs),
        eventName: 'boundary_event',
      })
    }

    const before = await read('boundary-person')
    expect(before.statusCode).toBe(200)
    expect(before.json().events).toBe(4)

    // Boundary between the second and third event. NO dictionary reload, and
    // no sleep: this path reads Postgres directly, which is the whole reason
    // it bypasses the dictionaries.
    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,$3)',
      [projectA, 'boundary-person', new Date(base + boundaryOffsetMs)],
    )

    const after = await read('boundary-person')
    expect(after.statusCode).toBe(200)
    // 1, not 2: the event stamped EXACTLY at the boundary instant is hidden
    // along with the two before it, strictly greater-than. A `>=` regression
    // would keep it and report 2.
    expect(after.json().events).toBe(1)
    expect(new Date(after.json().first_seen).getTime()).toBe(base + 3 * 3_600_000)
  })

  // The 404-vs-empty-result decision this route already makes ("answers 404
  // for an id with no known events, bindings, or aliases", above) extended to
  // a person whose events all predate their own deletion boundary: the same
  // answer as a person who never existed, which is the honest one — there is
  // no subject left to describe.
  //
  // Needs its own event, timestamped well before the suppressed_at below —
  // without one, this id already 404s with no suppression logic involved at
  // all (zero events, same as the existing no-history test), which would not
  // discriminate the boundary being honoured from it being ignored entirely.
  it('404s a person whose entire history predates the boundary', async () => {
    await insertEvent({
      projectId: projectA,
      userId: 'fully-erased',
      timestamp: chAt(-60),
      eventName: 'fully_erased_event',
    })
    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,now())',
      [projectA, 'fully-erased'],
    )
    expect((await read('fully-erased')).statusCode).toBe(404)
  })
})

/**
 * Mocked deps for the SQL-injection-shaped-id case, same pattern as
 * identity-routes.test.ts's mocked-deps describe block: a fake ClickHouse
 * client whose `query()` records the exact query text and params it was
 * called with, so this test can assert the id never touches the SQL string
 * itself, without needing a live-service reproduction of an injection.
 */
describe('GET /v1/persons/:id (mocked ClickHouse): parameter binding', () => {
  // Would catch: building the WHERE clause by interpolating the path id
  // directly into the query string (e.g. template-literal-ing `group` in)
  // instead of passing it through `query_params` — the captured query text
  // would then contain the raw dangerous id (and, on a real ClickHouse
  // server, the injected SQL would execute) rather than the `{group:...}`
  // placeholder this test asserts on.
  it('passes the path id to ClickHouse as a bound parameter, never interpolated into the query text', async () => {
    const dangerousId = "x'); DROP TABLE events; --"
    let capturedQuery = ''
    let capturedParams: Record<string, unknown> = {}
    const fakeCh = {
      query: async (opts: { query: string; query_params?: Record<string, unknown> }) => {
        capturedQuery = opts.query
        capturedParams = opts.query_params ?? {}
        return {
          json: async () => [
            {
              first_seen: '2026-01-01 00:00:00.000',
              last_seen: '2026-01-01 00:00:00.000',
              events: '1',
            },
          ],
        }
      },
    } as unknown as ClickHouseClient
    // A fake `authenticate` standing in for the bridge (auth/bridge.ts) —
    // this test's own concern is ClickHouse parameter binding, not auth, so
    // it reproduces just enough of the real server-key check (a header
    // match to a canned Project) rather than pulling in the real bridge and
    // its Postgres/session dependencies.
    const fakeAuthenticate: Authenticate = async (req) =>
      req.headers['x-lyraflow-server-key'] === 'sk_fake'
        ? ({ id: 1, slug: 'fake', retentionMonths: 1, monthlyEventQuota: 1 } as Project)
        : null
    const fakeBindings = {
      devicesForAny: async () => [],
      mostRecentPersonFor: async () => null,
      // Called unconditionally once devices is known, even when it is empty
      // (see person.ts) — without this the route throws before reaching the
      // ClickHouse query this test actually exercises.
      bindEventsForDevices: async () => new Map(),
    } as unknown as PersonDeps['bindings']
    const fakeAliases = {
      canonicalFor: async (_p: number, id: string) => id,
      mergedFrom: async () => [],
    } as unknown as PersonDeps['aliases']
    // No suppression row for anyone in this test — its own concern is
    // parameter binding, not the boundary, so this simply stays out of the
    // way (see person.test.ts's dedicated boundary tests above).
    const fakeSuppression = {
      boundaryFor: async () => null,
    } as unknown as PersonDeps['suppression']

    const mockedApp = Fastify()
    registerPersonRoutes(mockedApp, {
      authenticate: fakeAuthenticate,
      ch: fakeCh,
      bindings: fakeBindings,
      aliases: fakeAliases,
      suppression: fakeSuppression,
    })

    const res = await mockedApp.inject({
      method: 'GET',
      url: `/v1/persons/${encodeURIComponent(dangerousId)}`,
      headers: { 'x-lyraflow-server-key': 'sk_fake' },
    })

    expect(res.statusCode).toBe(200)
    expect(capturedQuery).not.toContain('DROP TABLE')
    expect(capturedQuery).toContain('{group:Array(String)}')
    expect(capturedParams.group).toEqual([dangerousId])
    await mockedApp.close()
  })
})
