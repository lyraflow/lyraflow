import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashServerKey } from '../auth/project-cache.js'
import { PersonAliases } from '../identity/aliases.js'
import { IdentityBindings } from '../identity/bindings.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  type PersonWindow,
  resolvePersonScope,
} from '../identity/scope.js'
import { purgePerson } from './purge.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const bindings = new IdentityBindings(pg)
const aliases = new PersonAliases(pg)

const SLUG_A = 'purge-a'
const SLUG_B = 'purge-b'
const WRITE_KEY_A = 'wk_purge_a'
const SERVER_KEY_A = 'sk_purge_a'
const WRITE_KEY_B = 'wk_purge_b'
const SERVER_KEY_B = 'sk_purge_b'

let projectA: number
let projectB: number

/**
 * Fixtures are anchored to the current run, not to an absolute date — the
 * ingest path clamps a client timestamp older than 24h, and even though
 * these tests write directly to ClickHouse (bypassing that clamp), a
 * hardcoded date would still silently drift relative to other assumptions
 * elsewhere in the suite. Same pattern as export.test.ts's BASE_MS.
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000

/** ClickHouse DateTime64(3) literal, for direct inserts. */
const chStamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
const chAt = (minutes: number) => chStamp(new Date(BASE_MS + minutes * 60_000))

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

/**
 * Cleans both stores for this file's two projects, looking the ids up by
 * slug first rather than trusting `projectA`/`projectB` — a run that died
 * mid-suite leaves ClickHouse rows behind with the OLD project id, which
 * nothing else cleans up (Postgres `projects` cascade does not reach
 * ClickHouse). Run at the TOP of `beforeAll`, not only in `afterAll`, so the
 * file is safe to run standalone three times in a row — this task's own
 * non-negotiable, since this file's whole point is to delete rows out from
 * under a shared test database.
 *
 * Every ClickHouse table this task touches is cleaned here: `events`,
 * `device_index`, `person_traits` and `events_dead_letter`. Postgres cleanup
 * is a single `DELETE FROM projects`: `identity_bindings`, `person_aliases`,
 * `suppressed_persons` and `deletion_requests` all carry
 * `ON DELETE CASCADE` back to `projects` (003/005/008_*.sql).
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    const list = ids.join(',')
    await ch.command({ query: `ALTER TABLE events DELETE WHERE project_id IN (${list})` })
    await ch.command({ query: `ALTER TABLE device_index DELETE WHERE project_id IN (${list})` })
    await ch.command({ query: `ALTER TABLE person_traits DELETE WHERE project_id IN (${list})` })
    await ch.command({
      query: `ALTER TABLE events_dead_letter DELETE WHERE project_id IN (${list})`,
    })
  }
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  projectA = await makeProject(SLUG_A, 'Purge A', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'Purge B', WRITE_KEY_B, SERVER_KEY_B)
})

afterAll(async () => {
  await cleanup()
  await pg.end()
  await ch.close()
})

async function insertEvent(opts: {
  projectId: number
  eventId?: string
  anonymousId?: string
  userId?: string
  timestamp: string
  eventName: string
  properties?: Record<string, string>
}): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: opts.projectId,
        event_id: opts.eventId ?? randomUUID(),
        anonymous_id: opts.anonymousId ?? '',
        user_id: opts.userId ?? '',
        event_name: opts.eventName,
        timestamp: opts.timestamp,
        received_at: opts.timestamp,
        trusted: 0,
        properties: opts.properties ?? {},
        properties_num: {},
      },
    ],
  })
}

async function eventCount(
  projectId: number,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM events WHERE project_id = {projectId:UInt32} AND ${where}`,
    query_params: { projectId, ...params },
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ c: string }>()
  return row ? Number(row.c) : 0
}

async function rowCount(
  table: string,
  projectId: number,
  where: string,
  params: Record<string, unknown>,
): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM ${table} WHERE project_id = {projectId:UInt32} AND ${where}`,
    query_params: { projectId, ...params },
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ c: string }>()
  return row ? Number(row.c) : 0
}

/**
 * Wraps a real ClickHouse client so its FIRST `command()` call (and only
 * that one) throws instead of reaching the server, then falls back to the
 * real client for everything after. Used by the ordering test to simulate a
 * purge attempt that dies partway through — the events mutation is always
 * the first `command()` call `purgePerson` issues, in both the correct
 * implementation and the mutation described on that test, so this reliably
 * interrupts the run at exactly that point regardless of which store's
 * delete the code actually runs first.
 *
 * A hand-built fake object, not `vi.spyOn` on the shared `ch` — the same
 * convention export.test.ts uses for its own forced-failure test, and it
 * avoids having to restore a patched method on a client every other test in
 * this file shares.
 */
function chFailingFirstCommand(real: ClickHouseClient): ClickHouseClient {
  let calls = 0
  return {
    command: async (params: Parameters<ClickHouseClient['command']>[0]) => {
      calls += 1
      if (calls === 1) throw new Error('injected failure: simulated mid-purge crash')
      return real.command(params)
    },
    // Delegated: the purge READS before it writes now, to learn which property
    // keys belong to this person before their events are deleted (#144). This
    // stub exists to fail the first MUTATION, so the reads pass straight
    // through -- injecting a failure here would test a different thing.
    query: (params: Parameters<ClickHouseClient['query']>[0]) => real.query(params),
  } as unknown as ClickHouseClient
}

describe('purgePerson', () => {
  // THE single most load-bearing test in this plan. See purge.ts's own
  // docstring for the full argument; this proves it rather than merely
  // asserting the happy path.
  //
  // Deliberately does NOT reuse the scope resolved for the first (failed)
  // attempt — it re-resolves from Postgres from scratch before the retry,
  // exactly like the deletion worker's lease-recovery restart. Reusing the
  // first scope object would keep the device windows in memory even after
  // `identity_bindings` had been deleted underneath them, which would make
  // this test pass regardless of purge.ts's actual step order — the one
  // failure mode this test exists to catch.
  it('deletes events before identity, or the events become unreachable on retry', async () => {
    const person = `order-person-${randomUUID()}`
    const device = `order-device-${randomUUID()}`
    const bindAt = new Date(BASE_MS + 30 * 60_000)

    await bindings.bind(projectA, device, person, bindAt)

    // Anonymous browsing on the device before the identify() — only
    // reachable, after the bind, through the device's WINDOW, never through
    // `user_id`.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chAt(10),
      eventName: 'order_anon_before_identify',
    })
    // The identified event itself.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      userId: person,
      timestamp: chAt(40),
      eventName: 'order_identified',
    })

    const scope1 = await resolvePersonScope({ bindings, aliases }, projectA, person)
    expect(scope1.windows.length).toBeGreaterThan(0)

    const flakyCh = chFailingFirstCommand(ch)
    await expect(
      purgePerson({ ch: flakyCh, pg, projectId: projectA, scope: scope1 }),
    ).rejects.toThrow(/injected failure/)

    // The retry: re-resolved from scratch, not the `scope1` object above —
    // the real client this time, so it actually runs to completion.
    const scope2 = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope: scope2 })

    const remaining = await eventCount(
      projectA,
      '(user_id = {p:String} OR anonymous_id = {d:String})',
      {
        p: person,
        d: device,
      },
    )
    expect(remaining).toBe(0)
  })

  it('is idempotent', async () => {
    const person = `idem-person-${randomUUID()}`
    const device = `idem-device-${randomUUID()}`
    const bindAt = new Date(BASE_MS + 30 * 60_000)

    await bindings.bind(projectA, device, person, bindAt)
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chAt(10),
      eventName: 'idem_anon_before_identify',
    })
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      userId: person,
      timestamp: chAt(40),
      eventName: 'idem_identified',
    })

    const scope1 = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope: scope1 })

    // The retry a lease recovery performs: a fresh resolution (now against
    // an already-erased person) and a second full run.
    const scope2 = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await expect(
      purgePerson({ ch, pg, projectId: projectA, scope: scope2 }),
    ).resolves.toBeUndefined()

    const remaining = await eventCount(
      projectA,
      '(user_id = {p:String} OR anonymous_id = {d:String})',
      {
        p: person,
        d: device,
      },
    )
    expect(remaining).toBe(0)
    const bindingsLeft = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND person_id = $2',
      [projectA, person],
    )
    expect(bindingsLeft.rowCount).toBe(0)
  })

  it('waits for each mutation instead of merely issuing it', async () => {
    const person = `sync-person-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: person,
      timestamp: chAt(10),
      eventName: 'sync_event',
    })

    // A behavioural check alone (assert 0 rows the instant purgePerson
    // resolves) is a genuine race against ClickHouse's own mutation
    // scheduler: on a table this small, a queued-but-not-yet-applied
    // mutation can still finish before this test's own SELECT reaches the
    // server, which would let a version WITHOUT mutations_sync pass this
    // assertion by luck rather than by correctness. Recording every
    // `clickhouse_settings` this run's mutations actually carried is the
    // deterministic half of this test — it cannot pass by timing coincidence
    // — and it is what step 5's own mutation table implies is being
    // checked ("without this, completed_at would come to mean 'I asked'").
    const seenSettings: (Record<string, unknown> | undefined)[] = []
    const recordingCh = {
      command: (params: Parameters<ClickHouseClient['command']>[0]) => {
        seenSettings.push(params.clickhouse_settings)
        return ch.command(params)
      },
      // Delegated unchanged: purgePerson also READS now, to find the event
      // names a purge left with nothing behind them (#66). This fake only
      // exists to observe `command`, so the read passes straight through.
      query: (params: Parameters<ClickHouseClient['query']>[0]) => ch.query(params),
    } as unknown as ClickHouseClient

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch: recordingCh, pg, projectId: projectA, scope })

    expect(seenSettings.length).toBeGreaterThan(0)
    for (const settings of seenSettings) {
      expect(settings?.mutations_sync).toBe('1')
    }

    // No polling, no sleep, no retry: the very next statement is the
    // assertion. Without mutations_sync = 1 this can still see the row —
    // ALTER ... DELETE is asynchronous by default.
    const remaining = await eventCount(projectA, 'user_id = {p:String}', { p: person })
    expect(remaining).toBe(0)
  })

  it('removes the person from device_index and person_traits', async () => {
    const person = `agg-person-${randomUUID()}`

    // Any event populates device_index via device_index_mv. A $identify
    // event with a trait populates person_traits via person_traits_str_mv.
    await insertEvent({
      projectId: projectA,
      userId: person,
      timestamp: chAt(10),
      eventName: 'agg_pageview',
    })
    await insertEvent({
      projectId: projectA,
      userId: person,
      timestamp: chAt(11),
      eventName: '$identify',
      properties: { plan: 'pro' },
    })

    const before = await rowCount('device_index', projectA, 'user_id = {p:String}', { p: person })
    expect(before).toBeGreaterThan(0)
    const traitsBefore = await rowCount('person_traits', projectA, 'user_id = {p:String}', {
      p: person,
    })
    expect(traitsBefore).toBeGreaterThan(0)

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    const deviceIndexAfter = await rowCount('device_index', projectA, 'user_id = {p:String}', {
      p: person,
    })
    expect(deviceIndexAfter).toBe(0)
    const traitsAfter = await rowCount('person_traits', projectA, 'user_id = {p:String}', {
      p: person,
    })
    expect(traitsAfter).toBe(0)
  })

  it("removes dead-letter rows carrying the person's ids", async () => {
    const person = `dl-person-${randomUUID()}`
    const device = `dl-device-${randomUUID()}`
    const other = `dl-other-${randomUUID()}`
    const bindAt = new Date(BASE_MS + 10 * 60_000)

    // A device bound to the person — so `scope.ids` (group ∪ devices) has a
    // device id in it, not just the person id, and the dead-letter match can
    // be checked against BOTH halves of `{ids:Array(String)}` independently.
    await bindings.bind(projectA, device, person, bindAt)

    await ch.insert({
      table: 'events_dead_letter',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          received_at: chAt(10),
          reason: 'invalid_payload',
          detail: 'test fixture',
          payload: JSON.stringify({ user_id: person, event: 'broken' }),
        },
        // Keyed on the DEVICE id, never the person id — only reachable
        // through `scope.devices`'s contribution to `scope.ids`. A version
        // that matched dead-letter rows against `scope.group` alone (the
        // person ids only) would leave this one behind.
        {
          project_id: projectA,
          received_at: chAt(12),
          reason: 'invalid_payload',
          detail: 'test fixture',
          payload: JSON.stringify({ anonymous_id: device, event: 'broken' }),
        },
        {
          project_id: projectA,
          received_at: chAt(11),
          reason: 'invalid_payload',
          detail: 'test fixture',
          payload: JSON.stringify({ user_id: other, event: 'broken' }),
        },
        // A prefix collision, not the person's id — `bob` must not match
        // inside `bobby`. Pins the quoted-form match on the purge side, the
        // same guarantee export.test.ts pins on the export side.
        {
          project_id: projectA,
          received_at: chAt(13),
          reason: 'invalid_payload',
          detail: 'test fixture',
          payload: JSON.stringify({ user_id: `${person}x`, event: 'broken' }),
        },
      ],
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    const mineLeft = await rowCount(
      'events_dead_letter',
      projectA,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: person },
    )
    expect(mineLeft).toBe(0)
    const deviceLeft = await rowCount(
      'events_dead_letter',
      projectA,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: device },
    )
    expect(deviceLeft).toBe(0)
    const othersLeft = await rowCount(
      'events_dead_letter',
      projectA,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: other },
    )
    expect(othersLeft).toBe(1)
    const prefixCollisionLeft = await rowCount(
      'events_dead_letter',
      projectA,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: `${person}x` },
    )
    expect(prefixCollisionLeft).toBe(1)
  })

  it("leaves another project's identical ids untouched", async () => {
    const person = `cross-person-${randomUUID()}`
    const device = `cross-device-${randomUUID()}`
    const bindAt = new Date(BASE_MS + 30 * 60_000)

    // The SAME person id and device id, bound and eventing in BOTH
    // projects — including a `$identify` (so person_traits gets a row in
    // each project too), not just plain events. This is what makes the
    // test able to catch a `rawIdentity` predicate that forgets its own
    // `project_id` clause (step 2 & 3's device_index/person_traits
    // deletes): without it, purging project A's person would also erase
    // project B's device_index/person_traits rows for the identical raw
    // (anonymous_id, user_id) pair, which `events` alone (still filtered by
    // its own always-present `project_id` clause) would never reveal.
    await bindings.bind(projectA, device, person, bindAt)
    await bindings.bind(projectB, device, person, bindAt)
    for (const projectId of [projectA, projectB]) {
      await insertEvent({
        projectId,
        anonymousId: device,
        timestamp: chAt(10),
        eventName: 'cross_anon',
      })
      await insertEvent({
        projectId,
        anonymousId: device,
        userId: person,
        timestamp: chAt(40),
        eventName: 'cross_identified',
      })
      await insertEvent({
        projectId,
        anonymousId: device,
        userId: person,
        timestamp: chAt(41),
        eventName: '$identify',
        properties: { plan: 'cross' },
      })
      // A dead-letter row carrying the person's id, in EACH project — cross-
      // tenant isolation for step 4, which the earlier version of this test
      // never exercised: it only checked `events` (already project-scoped by
      // its own `project_id` clause, unaffected by a dead-letter-specific
      // regression) and Postgres `identity_bindings`.
      await ch.insert({
        table: 'events_dead_letter',
        format: 'JSONEachRow',
        values: [
          {
            project_id: projectId,
            received_at: chAt(12),
            reason: 'invalid_payload',
            detail: 'cross-project fixture',
            payload: JSON.stringify({ user_id: person, event: 'broken' }),
          },
        ],
      })
    }

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    const leftInA = await eventCount(
      projectA,
      '(user_id = {p:String} OR anonymous_id = {d:String})',
      { p: person, d: device },
    )
    expect(leftInA).toBe(0)
    const leftInB = await eventCount(
      projectB,
      '(user_id = {p:String} OR anonymous_id = {d:String})',
      { p: person, d: device },
    )
    expect(leftInB).toBe(3)

    const deviceIndexInA = await rowCount('device_index', projectA, 'user_id = {p:String}', {
      p: person,
    })
    expect(deviceIndexInA).toBe(0)
    const deviceIndexInB = await rowCount('device_index', projectB, 'user_id = {p:String}', {
      p: person,
    })
    expect(deviceIndexInB).toBeGreaterThan(0)

    const traitsInA = await rowCount('person_traits', projectA, 'user_id = {p:String}', {
      p: person,
    })
    expect(traitsInA).toBe(0)
    const traitsInB = await rowCount('person_traits', projectB, 'user_id = {p:String}', {
      p: person,
    })
    expect(traitsInB).toBeGreaterThan(0)

    const bindingInA = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2 AND person_id = $3',
      [projectA, device, person],
    )
    expect(bindingInA.rowCount).toBe(0)
    const bindingInB = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2 AND person_id = $3',
      [projectB, device, person],
    )
    expect(bindingInB.rowCount).toBe(1)

    const dlInA = await rowCount(
      'events_dead_letter',
      projectA,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: person },
    )
    expect(dlInA).toBe(0)
    const dlInB = await rowCount(
      'events_dead_letter',
      projectB,
      "position(payload, concat('\"', {p:String}, '\"')) > 0",
      { p: person },
    )
    expect(dlInB).toBe(1)
  })

  it('leaves a co-tenant of a shared device identified elsewhere', async () => {
    const device = `shared-device-${randomUUID()}`
    const alice = `shared-alice-${randomUUID()}`
    const bob = `shared-bob-${randomUUID()}`
    const aliceBoundAt = new Date(BASE_MS + 10 * 60_000)
    const bobBoundAt = new Date(BASE_MS + 30 * 60_000)

    await bindings.bind(projectA, device, alice, aliceBoundAt)
    await bindings.bind(projectA, device, bob, bobBoundAt)

    // Alice's anonymous browsing, before her own bind — still inside her
    // window (retroactive attachment), and strictly before bob's rebind.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chAt(5),
      eventName: 'shared_alice_anon',
    })
    // Alice's identified event, between the two binds.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      userId: alice,
      timestamp: chAt(20),
      eventName: 'shared_alice_identified',
    })
    // Bob's identified event, after his bind.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      userId: bob,
      timestamp: chAt(40),
      eventName: 'shared_bob_identified',
    })
    // THE fixture the window-less "simplification" of the events predicate
    // would get wrong: anonymous browsing on the SAME device, but strictly
    // AFTER bob's rebind — outside alice's window entirely. A device-wide
    // (not time-split) match on `anonymous_id IN devices` would delete this
    // even though alice never touched the device again once bob took it
    // over. Without this event, a whole-device predicate and a correctly
    // time-split one are indistinguishable to this test — every anonymous
    // event in the fixture happens to fall in alice's own era, so both
    // implementations would delete the same rows and this test would pass
    // regardless of whether the code is actually time-splitting anything.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chAt(45),
      eventName: 'shared_bob_anon',
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, alice)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    const aliceLeft = await eventCount(projectA, 'user_id = {p:String}', { p: alice })
    expect(aliceLeft).toBe(0)
    const aliceAnonLeft = await eventCount(projectA, "event_name = 'shared_alice_anon'", {})
    expect(aliceAnonLeft).toBe(0)

    const bobLeft = await eventCount(projectA, 'user_id = {p:String}', { p: bob })
    expect(bobLeft).toBe(1)
    // THE load-bearing assertion added for the window-less-predicate
    // mutation: bob's anonymous browsing, in his own era on the shared
    // device, must survive a purge of alice.
    const bobAnonLeft = await eventCount(projectA, "event_name = 'shared_bob_anon'", {})
    expect(bobAnonLeft).toBe(1)

    // The load-bearing assertion for THIS test: bob's own binding row for
    // the shared device must survive — bindings are deleted by PERSON, never
    // by device.
    const bobBinding = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2 AND person_id = $3',
      [projectA, device, bob],
    )
    expect(bobBinding.rowCount).toBe(1)
    const aliceBinding = await pg.query(
      'SELECT 1 FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2 AND person_id = $3',
      [projectA, device, alice],
    )
    expect(aliceBinding.rowCount).toBe(0)
  })

  // The `person_aliases` delete has no other coverage in this file: no other
  // fixture ever creates an alias, so nothing else exercises either the
  // alias-row deletion itself or `scope.group`'s expansion over a
  // merged-away id (resolvePersonScope's step 2 — see scope.ts's own
  // docstring on why that step is not optional).
  it("purges a merged-away id's alias row and its own events", async () => {
    const canonical = `merge-canonical-${randomUUID()}`
    const mergedAway = `merge-away-${randomUUID()}`

    const merged = await aliases.alias(projectA, mergedAway, canonical)
    expect(merged).toBe('merged')

    await insertEvent({
      projectId: projectA,
      userId: canonical,
      timestamp: chAt(10),
      eventName: 'merge_canonical_event',
    })
    // Recorded under the OLD id — exactly the case scope.ts warns about:
    // /v1/alias never repoints history already written under the merged-away
    // id, so it is only reachable at all through `scope.group`'s expansion.
    await insertEvent({
      projectId: projectA,
      userId: mergedAway,
      timestamp: chAt(11),
      eventName: 'merge_away_event',
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, canonical)
    // The exercise this test is actually about: resolving the CANONICAL id
    // pulls the merged-away id into the group too.
    expect(scope.group.sort()).toEqual([canonical, mergedAway].sort())

    await purgePerson({ ch, pg, projectId: projectA, scope })

    const canonicalLeft = await eventCount(projectA, 'user_id = {p:String}', { p: canonical })
    expect(canonicalLeft).toBe(0)
    const mergedAwayLeft = await eventCount(projectA, 'user_id = {p:String}', { p: mergedAway })
    expect(mergedAwayLeft).toBe(0)

    const aliasRow = await pg.query(
      'SELECT 1 FROM person_aliases WHERE project_id = $1 AND person_id = $2',
      [projectA, mergedAway],
    )
    expect(aliasRow.rowCount).toBe(0)
  })

  // Neither of these tables is ever written by purgePerson — this is a
  // negative test with nothing else in the file to catch a future step that
  // starts touching either. suppressed_persons is the backstop against a
  // restored backup resurrecting the person (008_deletion_requests.sql);
  // event_schema has no identity column at all, and deleting from it would
  // corrupt autocomplete for the whole project, not just this person.
  it('leaves suppressed_persons untouched', async () => {
    const person = `untouched-person-${randomUUID()}`

    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1, $2, now())',
      [projectA, person],
    )

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    const suppression = await pg.query(
      'SELECT 1 FROM suppressed_persons WHERE project_id = $1 AND person_id = $2',
      [projectA, person],
    )
    expect(suppression.rowCount).toBe(1)
  })

  // This test used to assert the OPPOSITE, in the same case, and passed --
  // it pinned the defect. `purgePerson` deliberately left event_schema alone
  // on the reasoning that it holds no personal data; an event name a person
  // fired once is personal data, and the endpoint kept offering it forever
  // (#66). Inverting that pin is the point of the change, not an obstacle to
  // route around.
  it('removes an event name the purge left with nothing behind it', async () => {
    const person = `stale-schema-person-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: person,
      timestamp: chAt(10),
      eventName: 'viewed_patient_record',
      properties: { untouched_key: 'x' },
    })

    // Present before, or the assertion after proves nothing about the purge.
    expect(
      await rowCount('event_schema', projectA, "event_name = 'viewed_patient_record'", {}),
    ).toBeGreaterThan(0)

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    expect(
      await rowCount('event_schema', projectA, "event_name = 'viewed_patient_record'", {}),
    ).toBe(0)
  })

  // The constraint the old behaviour existed to protect, now asserted rather
  // than assumed. A name with zero remaining events cannot corrupt an
  // autocomplete because it can never match; a name someone else still fires
  // absolutely can, and must survive.
  it('keeps an event name another person is still sending', async () => {
    const erased = `shared-name-erased-${randomUUID()}`
    const other = `shared-name-other-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: erased,
      timestamp: chAt(10),
      eventName: 'shared_event_name',
      properties: { shared_key: 'x' },
    })
    await insertEvent({
      projectId: projectA,
      userId: other,
      timestamp: chAt(9),
      eventName: 'shared_event_name',
      properties: { shared_key: 'y' },
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, erased)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    expect(
      await rowCount('event_schema', projectA, "event_name = 'shared_event_name'", {}),
    ).toBeGreaterThan(0)
  })

  // #144: step 6 sweeps an event NAME with nothing behind it. This is the
  // level below -- a name other people still send, carrying a key only the
  // erased person ever supplied.
  it('removes a property key only the erased person ever sent', async () => {
    const erased = `own-key-erased-${randomUUID()}`
    const other = `own-key-other-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: erased,
      timestamp: chAt(10),
      eventName: 'checkout',
      properties: { patient_id: 'p-1', currency: 'GBP' },
    })
    await insertEvent({
      projectId: projectA,
      userId: other,
      timestamp: chAt(9),
      eventName: 'checkout',
      properties: { currency: 'USD' },
    })

    expect(
      await rowCount(
        'event_schema',
        projectA,
        "event_name = 'checkout' AND property_key = 'patient_id'",
        {},
      ),
    ).toBeGreaterThan(0)

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, erased)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    // The key only they sent is gone...
    expect(
      await rowCount(
        'event_schema',
        projectA,
        "event_name = 'checkout' AND property_key = 'patient_id'",
        {},
      ),
    ).toBe(0)
    // ...the event name survives, because someone else still fires it...
    expect(await rowCount('event_schema', projectA, "event_name = 'checkout'", {})).toBeGreaterThan(
      0,
    )
    // ...and so does the key the co-tenant still sends. Without this the test
    // above passes against a sweep that deleted the whole event name.
    expect(
      await rowCount(
        'event_schema',
        projectA,
        "event_name = 'checkout' AND property_key = 'currency'",
        {},
      ),
    ).toBeGreaterThan(0)
  })

  // A key the erased person sent AND someone else still sends must stay. The
  // sweep asks "does any surviving event still carry this", not "did they
  // touch it".
  it('keeps a property key the erased person shared with someone else', async () => {
    const erased = `shared-key-erased-${randomUUID()}`
    const other = `shared-key-other-${randomUUID()}`
    for (const [user, ts] of [
      [erased, chAt(10)],
      [other, chAt(9)],
    ] as const) {
      await insertEvent({
        projectId: projectA,
        userId: user,
        timestamp: ts,
        eventName: 'shared_key_event',
        properties: { shared_prop: 'x' },
      })
    }

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, erased)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    expect(
      await rowCount(
        'event_schema',
        projectA,
        "event_name = 'shared_key_event' AND property_key = 'shared_prop'",
        {},
      ),
    ).toBeGreaterThan(0)
  })

  // Tenancy, for the new step specifically. The sweep is driven by a NOT IN
  // over this project's own events, so a name that is stale here but busy in
  // another project must not be swept there -- and the reverse.
  it("does not sweep another project's identically named event", async () => {
    const erased = `tenancy-schema-${randomUUID()}`
    const elsewhere = `tenancy-schema-other-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: erased,
      timestamp: chAt(10),
      eventName: 'cross_project_event',
      properties: { k: 'x' },
    })
    await insertEvent({
      projectId: projectB,
      userId: elsewhere,
      timestamp: chAt(10),
      eventName: 'cross_project_event',
      properties: { k: 'y' },
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, erased)
    await purgePerson({ ch, pg, projectId: projectA, scope })

    expect(await rowCount('event_schema', projectA, "event_name = 'cross_project_event'", {})).toBe(
      0,
    )
    expect(
      await rowCount('event_schema', projectB, "event_name = 'cross_project_event'", {}),
    ).toBeGreaterThan(0)
  })

  // Named on its own, separately from "waits for each mutation" (which also
  // happens to use a windowless person, incidentally) — so that editing that
  // test to give its person a device cannot silently delete the only
  // coverage of chunkWindows's "empty windows still yields one chunk"
  // contract (scope.ts). Without it, a person whose events all carry their
  // own user_id (no device ever involved — the common server-side-only
  // tracking shape) would never have those events deleted at all.
  it('purges a person whose events carry no device window at all', async () => {
    const person = `no-window-person-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: person,
      timestamp: chAt(10),
      eventName: 'no_window_event',
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectA, person)
    expect(scope.windows).toHaveLength(0)

    await purgePerson({ ch, pg, projectId: projectA, scope })

    const remaining = await eventCount(projectA, 'user_id = {p:String}', { p: person })
    expect(remaining).toBe(0)
  })

  // The multi-chunk path: no fixture elsewhere in this file reaches
  // MAX_PERSON_RANGE_CLAUSES windows (that would mean 201 real devices,
  // each needing its own bind event), so this constructs a PersonScope
  // directly rather than resolving one, and inspects the ACTUAL mutations
  // purgePerson issues rather than only the end state — chunkWindows's
  // contract is "every chunk together covers the whole set, none twice",
  // which final-state assertions alone cannot distinguish from, say, only
  // ever running the first chunk.
  it("chunks a fragmented person's windows into disjoint mutations covering the whole set", async () => {
    const person = `chunk-person-${randomUUID()}`
    const totalWindows = MAX_PERSON_RANGE_CLAUSES + 1
    const windows: PersonWindow[] = Array.from({ length: totalWindows }, (_, i) => ({
      device: `chunk-device-${i}`,
      from: BASE_MS + i * 1000,
      to: BASE_MS + i * 1000 + 500,
    }))
    const scope: PersonScope = {
      canonical: person,
      group: [person],
      devices: windows.map((w) => w.device),
      ids: [person, ...windows.map((w) => w.device)].sort(),
      windows,
    }

    const eventsCalls: { query_params: Record<string, unknown> }[] = []
    const capturingCh = {
      command: (params: Parameters<ClickHouseClient['command']>[0]) => {
        if (params.query.includes('ALTER TABLE events DELETE')) {
          eventsCalls.push({
            query_params: (params.query_params ?? {}) as Record<string, unknown>,
          })
        }
        return ch.command(params)
      },
      // Delegated unchanged: purgePerson also READS now, to find the event
      // names a purge left with nothing behind them (#66). This fake only
      // exists to observe `command`, so the read passes straight through.
      query: (params: Parameters<ClickHouseClient['query']>[0]) => ch.query(params),
    } as unknown as ClickHouseClient

    await purgePerson({ ch: capturingCh, pg, projectId: projectA, scope })

    // ceil(201 / 200) = 2 chunks, one events mutation each.
    expect(eventsCalls).toHaveLength(2)

    const devicesPerCall = eventsCalls.map((call) =>
      Object.entries(call.query_params)
        .filter(([key]) => /_d\d+$/.test(key))
        .map(([, value]) => value as string),
    )
    expect(devicesPerCall[0]).toHaveLength(MAX_PERSON_RANGE_CLAUSES)
    expect(devicesPerCall[1]).toHaveLength(1)

    const seen = [...(devicesPerCall[0] ?? []), ...(devicesPerCall[1] ?? [])]
    // Disjoint: no device bound into more than one chunk's predicate.
    expect(new Set(seen).size).toBe(totalWindows)
    // Complete: the union of the chunks is the whole window set — nothing
    // silently dropped, and nothing left for a would-be third chunk.
    expect(new Set(seen)).toEqual(new Set(windows.map((w) => w.device)))
  })
})
