// Task 8b: the reviewer's probe against 005_suppression.sql's own claim —
// that a suppressed_persons row survives forever specifically so that
// restoring an older backup of the event store cannot resurrect a deleted
// person — proven end to end, through the exact same read path (the segment
// compiler's resolvedPersonExpr + notSuppressedExpr) every count, member
// list, and export goes through. See deletion-store.ts and
// suppression-store.ts's `upsertMany` for the fix this exercises, and
// task-8b-report.md for the before/after output this test produced when run
// against the pre-fix code (Step 3 of the brief: revert the fan-out, rerun,
// confirm the failure is exactly the merged-away id and the anonymous row).
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type FilterNode, compileSegment } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PersonAliases } from '../identity/aliases.js'
import { IdentityBindings } from '../identity/bindings.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { resolvePersonScope } from '../identity/scope.js'
import { runSegmentMembers } from '../segments/execute.js'
import { DeletionStore } from './deletion-store.js'
import { purgePerson } from './purge.js'
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

// ClickHouse resolves the dictionary source itself, from inside the compose
// network — see the identical note in dictionaries.test.ts, resolve.test.ts,
// execute.test.ts and routes.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const bindings = new IdentityBindings(pg)
const aliases = new PersonAliases(pg)
const suppression = new SuppressionStore(pg)
const deletions = new DeletionStore(pg, suppression)

const SLUG = 'purge-restore-a'

let projectId: number

/**
 * Fixtures are anchored to the current run, not to an absolute date — same
 * reasoning as purge.test.ts's own BASE_MS.
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000

/** ClickHouse DateTime64(3) literal, for direct inserts. */
const chStamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
const chAt = (minutes: number) => chStamp(new Date(BASE_MS + minutes * 60_000))

async function makeProject(slug: string, name: string): Promise<number> {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, 'h') RETURNING id`,
    [name, slug, `wk_${slug}`],
  )
  return Number(r.rows[0]?.id)
}

/**
 * Run at the TOP of `beforeAll`, not only in `afterAll` — this file's whole
 * point is to purge and restore rows out from under a shared test database,
 * so it has to be safe to run standalone, three times in a row, regardless
 * of what a previous crashed run left behind.
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
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()
  projectId = await makeProject(SLUG, 'Purge Restore A')
  await ensureIdentityDictionaries(ch, pgSource)
})

afterAll(async () => {
  await cleanup()
  await pg.end()
  await ch.close()
})

async function insertEvent(opts: {
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
        project_id: projectId,
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

/**
 * Forces every dictionary this file's assertions depend on to reflect the
 * CURRENT Postgres state, deterministically — the identity dictionaries'
 * LIFETIME(MIN 5 MAX 15) and suppressed_persons' LIFETIME(MIN 1 MAX 5) would
 * eventually pick up a change on their own, but a test cannot wait on that
 * without becoming either flaky or slow.
 */
async function reloadDictionaries(): Promise<void> {
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
}

/**
 * Every resolved person currently visible in this project — the segment
 * compiler's own "everyone" query (a trivially-true lifecycle filter, the
 * same shape execute.test.ts's "counts everyone in the base population"
 * test uses), run in `members` mode so the actual resolved `person_id`s come
 * back rather than just a count. This is the SAME production code path
 * (`compileSegment` → `resolvedPersonExpr` + `notSuppressedExpr` →
 * `runSegmentMembers`) every segment count, member list, and the export
 * route all share — asserting against it, rather than against a hand-built
 * ad-hoc query, is what makes this test prove the read path actually used in
 * production, not a stand-in for it.
 */
async function visiblePersonIds(): Promise<string[]> {
  const everyone: FilterNode = {
    kind: 'lifecycle',
    field: 'first_seen',
    operator: '>',
    value: new Date(BASE_MS - 3_600_000).toISOString(),
  }
  const rows = await runSegmentMembers({
    client: ch,
    compiled: compileSegment({
      query: { ast_version: 1, filter: everyone } as never,
      projectId,
      database: CH_DB,
      now: new Date(),
      select: 'members',
    }),
  })
  return rows.map((r) => r.person_id)
}

describe('a restored backup after a purge', () => {
  // THE reviewer's probe from task-8b-brief.md, as an assertion. Before Task
  // 8b, `restored_merged_away_id` and `restored_anonymous` resurfaced —
  // `resolvedPersonExpr` resolves both through `identity_bindings`/
  // `person_aliases`, which the purge's final step deletes, and a
  // suppression row keyed on the canonical alone stops covering either of
  // them the instant those mappings are gone. See task-8b-report.md for the
  // captured red output (this test run against a temporarily reverted,
  // canonical-only suppression write) and the green output after the fix.
  it('suppresses the canonical, a merged-away id, and an anonymous device event alike', async () => {
    const canonical = `restore-canonical-${randomUUID()}`
    const mergedAway = `restore-merged-away-${randomUUID()}`
    const device = `restore-device-${randomUUID()}`
    const bindAt = new Date(BASE_MS + 10 * 60_000)

    await bindings.bind(projectId, device, canonical, bindAt)
    const merged = await aliases.alias(projectId, mergedAway, canonical)
    expect(merged).toBe('merged')

    const restoredEvents = [
      // Anonymous pre-identify browsing on the device — reachable, before
      // the purge, only through the device's WINDOW; after it, through
      // nothing at all except identity_bindings' now-deleted row.
      { anonymousId: device, timestamp: chAt(5), eventName: 'restore_anon' },
      // The canonical's own identified event.
      {
        anonymousId: device,
        userId: canonical,
        timestamp: chAt(20),
        eventName: 'restore_canonical_event',
      },
      // History recorded under the id that was later merged away — only
      // reachable, before the purge, through scope.group's expansion; after
      // it, through nothing but the now-deleted person_aliases row.
      { userId: mergedAway, timestamp: chAt(15), eventName: 'restore_merged_away_event' },
    ]
    for (const ev of restoredEvents) await insertEvent(ev)

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, canonical)
    expect(scope.group.sort()).toEqual([canonical, mergedAway].sort())
    expect(scope.devices).toEqual([device])

    // The deletion: `at` is after every fixture event's own timestamp above,
    // so all three fall inside the boundary once restored.
    const at = new Date(BASE_MS + 60 * 60_000)
    await deletions.request(projectId, scope.canonical, scope.ids, at)

    // The purge: deletes the events AND — load-bearing for this test — the
    // identity_bindings/person_aliases mappings resolvedPersonExpr depends
    // on to resolve `mergedAway` and `device` back to `canonical` at all.
    await purgePerson({ ch, pg, projectId, scope })

    // "Restoring an older backup of the event store": the exact same three
    // rows, back in ClickHouse, exactly as they were pre-purge. Postgres's
    // identity_bindings/person_aliases are deliberately NOT restored — the
    // purge's deletion of those rows is the live system's current, correct
    // state; only the event store's backup predates it. That mismatch is
    // exactly why resolvedPersonExpr can no longer resolve `mergedAway` or
    // `device` back to `canonical`.
    for (const ev of restoredEvents) await insertEvent(ev)
    await reloadDictionaries()

    const visible = await visiblePersonIds()
    expect(visible).not.toContain(canonical)
    expect(visible).not.toContain(mergedAway)
    expect(visible).not.toContain(device)
  })
})

describe('a device reused by someone else after a deletion', () => {
  // The safety property the brief asks to be proven, not merely asserted:
  // suppression is time-scoped, so a device carrying a suppressed person's
  // old boundary must not blind every future tenant of that device forever.
  it("hides the erased person's own era on that device but not a later era on the same device", async () => {
    const alice = `reuse-alice-${randomUUID()}`
    const bob = `reuse-bob-${randomUUID()}`
    const device = `reuse-device-${randomUUID()}`
    const aliceBoundAt = new Date(BASE_MS + 10 * 60_000)

    await bindings.bind(projectId, device, alice, aliceBoundAt)
    await insertEvent({
      anonymousId: device,
      userId: alice,
      timestamp: chAt(20),
      eventName: 'reuse_alice_event',
    })

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, alice)
    expect(scope.devices).toEqual([device])

    // The boundary: after alice's own event, before anything below.
    const at = new Date(BASE_MS + 30 * 60_000)
    await deletions.request(projectId, scope.canonical, scope.ids, at)
    await purgePerson({ ch, pg, projectId, scope })

    // A gap with nobody bound to the device yet: anonymous browsing here,
    // AFTER the boundary, resolves via resolvedPersonExpr's stage-1 fallback
    // to the DEVICE id itself — the exact same identity the suppression row
    // above was keyed on. If suppression were presence-only rather than
    // time-scoped, this event would be hidden purely for sharing an id with
    // alice's old boundary, even though it has nothing to do with her.
    //
    // Checked in its OWN reload/query, before bob ever binds: once a new
    // bind exists, identity_bindings_dict_src's tiling (003_identity.sql)
    // makes the device's FIRST-remaining bind row cover retroactively back
    // to epoch — by design, the same rule that lets an anonymous session
    // predating a real bind attribute correctly (see resolve.test.ts's
    // "resolves an anonymous event from before the bind to the bound
    // person"). With alice's binding purged, bob's bind would become that
    // first row and retroactively reattribute this gap event to BOB, which
    // would still prove the event survives suppression but would no longer
    // be exercising the device-fallback identity this assertion is about.
    await insertEvent({
      anonymousId: device,
      timestamp: chAt(40),
      eventName: 'reuse_gap_anon_event',
    })
    await reloadDictionaries()
    const visibleDuringGap = await visiblePersonIds()
    expect(visibleDuringGap).not.toContain(alice)
    expect(visibleDuringGap).toContain(device)

    // The device is later bound to a genuinely different person, and that
    // person identifies on it — ordinary reuse, well after alice's boundary.
    const bobBoundAt = new Date(BASE_MS + 50 * 60_000)
    await bindings.bind(projectId, device, bob, bobBoundAt)
    await insertEvent({
      anonymousId: device,
      userId: bob,
      timestamp: chAt(60),
      eventName: 'reuse_bob_event',
    })
    await reloadDictionaries()

    const visible = await visiblePersonIds()
    // Alice's own history is gone (purged) and would stay hidden even if
    // restored — see the sibling describe block above for that proof.
    expect(visible).not.toContain(alice)
    // The load-bearing assertion: bob's own identified activity, after the
    // boundary, is NOT swept up by alice's old suppression row on the same
    // device.
    expect(visible).toContain(bob)
  })
})
