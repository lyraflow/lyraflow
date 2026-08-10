import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createChClient } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', 'docker-compose.ci.yml', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

const CH_DATABASE = 'lyraflow'
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DATABASE,
})

// A second client pinned to `default`. The HTTP interface sets the session's
// current database from the connection's `database`, and setting it to a
// database that does not exist is itself an error (UNKNOWN_DATABASE) — so the
// client above cannot issue the DROP DATABASE / RESTORE pair, because the
// RESTORE half runs at a moment when `lyraflow` is gone.
const chAdmin = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'default',
})

const BASE = 'http://localhost:3000'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36'

let writeKey: string

async function waitReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/ready`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Lyraflow did not become ready in time')
}

beforeAll(async () => {
  // Same reason as restart-durability.test.ts: volumes survive `down`, so a
  // previous run that died before afterAll would leave both a duplicate
  // project slug and — here — a `probe.zip` already on the backups disk, which
  // makes BACKUP fail with BACKUP_ALREADY_EXISTS for reasons that have nothing
  // to do with what is being tested.
  compose('down', '-v')
  compose('up', '-d', '--wait')
  await waitReady()
  const out = compose(
    'exec',
    '-T',
    'lyraflow',
    'node',
    'packages/cli/dist/index.js',
    'create-project',
    'Backup',
  )
  writeKey = /wk_[a-f0-9]+/.exec(out)?.[0] as string
  expect(writeKey).toBeTruthy()
}, 300_000)

afterAll(async () => {
  await ch.close()
  await chAdmin.close()
  compose('down', '-v')
})

async function countRows(table: string): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM ${table}`,
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ c: string }>()
  return Number(rows[0]?.c)
}

/**
 * Rows in a derived table attributable to one anonymous_id.
 *
 * Used instead of a bare row count for the post-restore check. device_index
 * and person_traits are AggregatingMergeTree and event_schema is
 * ReplacingMergeTree, so a background merge can collapse several rows into
 * one at any moment — a total count can therefore stay flat across an insert
 * that genuinely happened. Probing for a key that did not exist before the
 * restore cannot be confused by a merge: no merge invents a key, and no merge
 * removes the only row holding one.
 */
async function derivedRowsFor(table: string, anonymousId: string): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM ${table} WHERE anonymous_id = {anon:String}`,
    query_params: { anon: anonymousId },
    format: 'JSONEachRow',
  })
  return Number((await rs.json<{ c: string }>())[0]?.c)
}

/**
 * Distinct trait keys recorded for one identity, sorted.
 *
 * person_traits is fed by TWO views — person_traits_str_mv and
 * person_traits_num_mv — and a bare "are there any rows" probe cannot tell
 * them apart: with the numeric view missing, the string view alone still
 * produces rows. Verified: dropping only person_traits_num_mv after RESTORE
 * left every count-shaped assertion in this file green. Asserting the key set
 * makes each view individually load-bearing.
 */
async function traitKeysFor(anonymousId: string): Promise<string[]> {
  const rs = await ch.query({
    query: `
      SELECT DISTINCT trait_key FROM person_traits
      WHERE anonymous_id = {anon:String} ORDER BY trait_key
    `,
    query_params: { anon: anonymousId },
    format: 'JSONEachRow',
  })
  return (await rs.json<{ trait_key: string }>()).map((r) => r.trait_key)
}

/**
 * Distinct value kinds recorded for one event name, sorted. Same argument as
 * traitKeysFor: event_schema is fed by event_schema_str_mv and
 * event_schema_num_mv, and only a kind-aware probe separates them.
 */
async function schemaKindsFor(eventName: string): Promise<string[]> {
  const rs = await ch.query({
    query: `
      SELECT DISTINCT value_kind FROM event_schema
      WHERE event_name = {name:String} ORDER BY value_kind
    `,
    query_params: { name: eventName },
    format: 'JSONEachRow',
  })
  return (await rs.json<{ value_kind: string }>()).map((r) => r.value_kind)
}

/** event_schema is keyed by event name, not by identity — same merge argument. */
async function schemaRowsFor(eventName: string): Promise<number> {
  const rs = await ch.query({
    query: 'SELECT count() AS c FROM event_schema WHERE event_name = {name:String}',
    query_params: { name: eventName },
    format: 'JSONEachRow',
  })
  return Number((await rs.json<{ c: string }>())[0]?.c)
}

/** Names of every materialized view in the application database, sorted. */
async function materializedViews(): Promise<string[]> {
  const rs = await ch.query({
    query: `
      SELECT name FROM system.tables
      WHERE database = '${CH_DATABASE}' AND engine = 'MaterializedView'
      ORDER BY name
    `,
    format: 'JSONEachRow',
  })
  return (await rs.json<{ name: string }>()).map((r) => r.name)
}

// A browser user-agent, and not optional. isBot() (packages/core) treats a
// missing UA — and any UA containing `curl/` — as a bot, and a bot payload is
// answered 202 and then silently discarded: no `events` row, and no
// events_dead_letter row either. A request made without this header looks
// accepted and simply never arrives.
const ingestHeaders = () => ({
  'content-type': 'application/json',
  'x-lyraflow-write-key': writeKey,
  'user-agent': UA,
})

async function postEvent(opts: { event: string; anonymousId: string }): Promise<void> {
  const res = await fetch(`${BASE}/v1/track`, {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({
      message_id: randomUUID(),
      anonymous_id: opts.anonymousId,
      event: opts.event,
      properties: { plan: 'pro', seats: 3 },
    }),
  })
  expect(res.status).toBe(202)
}

/**
 * identify() is what puts rows in person_traits — the third table fed only by
 * a materialized view, and the one a track() alone would never exercise.
 */
async function postIdentify(opts: { anonymousId: string; userId: string }): Promise<void> {
  const res = await fetch(`${BASE}/v1/identify`, {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({
      message_id: randomUUID(),
      anonymous_id: opts.anonymousId,
      user_id: opts.userId,
      traits: { tier: 'gold', mrr: 42 },
    }),
  })
  expect(res.status).toBe(202)
}

/**
 * Waits for the ingest buffer to have flushed everything accepted so far.
 *
 * The buffer flushes on a timer (LYRAFLOW_FLUSH_INTERVAL_MS, 1s by default),
 * so a fixed sleep is either flaky or slow. Instead: wait until `events` has
 * reached `atLeast` rows AND that count has stopped moving, so the row this
 * caller just posted is definitely visible and no later one is still in
 * flight. Materialized views fire inside the INSERT, so a settled `events`
 * count means the derived tables have settled too.
 */
async function flushAndWait(atLeast: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let previous = -1
  let last = -1
  while (Date.now() < deadline) {
    const current = await countRows('events')
    last = current
    if (current >= atLeast && current === previous) return
    previous = current
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(
    `ingest buffer never settled at >= ${atLeast} rows in ${timeoutMs}ms; last count was ${last}`,
  )
}

// Distinct identities and event names either side of the restore, deliberately.
// The three derived tables are all merging engines, so a background merge can
// collapse rows at any moment and a *total* row count can stay flat across an
// insert that really happened — observed: device_index read 4 both before and
// after a post-restore ingest that added two rows, because the merge that ran
// in between collapsed two duplicate keys. Every assertion below therefore
// probes for a key that provably did not exist before the restore.
const ANON_BEFORE = 'backup-before'
const ANON_AFTER = 'backup-after'
const EVENT_BEFORE = 'before_backup'
const EVENT_AFTER = 'after_restore'

describe('ClickHouse BACKUP and RESTORE', () => {
  it('restores the events table and the materialized views that feed it', async () => {
    // The sharp case. device_index, event_schema and person_traits are
    // populated ONLY by materialized views firing on INSERT INTO events. If
    // RESTORE brings back the target tables but not the views, a restored
    // deployment answers every historical query correctly and silently stops
    // updating those three for every event ingested afterwards.
    await postEvent({ event: EVENT_BEFORE, anonymousId: ANON_BEFORE })
    await postIdentify({ anonymousId: ANON_BEFORE, userId: 'backup-person' })
    await flushAndWait(2)

    const viewsBefore = await materializedViews()
    expect(viewsBefore.length).toBeGreaterThan(0)

    // Nothing post-restore has been ingested yet, so every "after" probe below
    // must currently read zero. Asserted rather than assumed: if these were
    // already non-zero the post-restore assertions would pass vacuously.
    expect(await derivedRowsFor('device_index', ANON_AFTER)).toBe(0)
    expect(await derivedRowsFor('person_traits', ANON_AFTER)).toBe(0)
    expect(await schemaRowsFor(EVENT_AFTER)).toBe(0)

    // Stop the app BEFORE snapshotting the counts, not after. A SIGTERM to the
    // server drains the ingest buffer with one last INSERT, so counting first
    // would leave a window in which the backup contains rows the baseline does
    // not — a flake that would read as "RESTORE invented rows".
    compose('stop', 'lyraflow')

    const beforeEvents = await countRows('events')
    const beforeIndex = await countRows('device_index')
    const beforeSchema = await countRows('event_schema')
    expect(beforeEvents).toBeGreaterThan(0)
    expect(beforeIndex).toBeGreaterThan(0)
    expect(beforeSchema).toBeGreaterThan(0)

    await ch.command({ query: `BACKUP DATABASE lyraflow TO Disk('backups', 'probe.zip')` })
    await chAdmin.command({ query: 'DROP DATABASE lyraflow SYNC' })
    await chAdmin.command({ query: `RESTORE DATABASE lyraflow FROM Disk('backups', 'probe.zip')` })
    compose('start', 'lyraflow')
    await waitReady()

    expect(await countRows('events')).toBe(beforeEvents)
    expect(await countRows('device_index')).toBe(beforeIndex)

    // The structural half of the answer: the view objects themselves, not just
    // the tables they write into, are named by `system.tables` after RESTORE.
    // Asserted separately from the behavioural check below because the two
    // fail differently — a missing view here says RESTORE dropped it, while a
    // pass here with a failure below would say it came back inert.
    expect(await materializedViews()).toEqual(viewsBefore)

    // The assertions that distinguish "the target tables came back" from "the
    // pipeline came back". Events ingested after the restore must still reach
    // all three derived tables — and all three are checked, not just
    // device_index: they are fed by five separate views, and RESTORE bringing
    // back four of them would be just as silent a failure as bringing back
    // none.
    await postEvent({ event: EVENT_AFTER, anonymousId: ANON_AFTER })
    await postIdentify({ anonymousId: ANON_AFTER, userId: 'backup-person-2' })
    await flushAndWait(beforeEvents + 2)

    expect(await derivedRowsFor('device_index', ANON_AFTER)).toBeGreaterThan(0)
    expect(await derivedRowsFor('person_traits', ANON_AFTER)).toBeGreaterThan(0)
    expect(await schemaRowsFor(EVENT_AFTER)).toBeGreaterThan(0)

    // One assertion per view rather than per table. `tier` can only have been
    // written by person_traits_str_mv and `mrr` only by person_traits_num_mv;
    // likewise 'string' and 'number' for the two event_schema views. Together
    // with device_index above, all five views are now separately required.
    expect(await traitKeysFor(ANON_AFTER)).toEqual(['mrr', 'tier'])
    expect(await schemaKindsFor(EVENT_AFTER)).toEqual(['number', 'string'])

    // Kept alongside the key probes above, not instead of them: this is the
    // shape the brief prescribed, and it is the one that would notice a view
    // that fires but writes nothing.
    expect(await countRows('device_index')).toBeGreaterThan(beforeIndex)
  }, 300_000)

  it('names the missing configuration when the backups disk is not declared', async () => {
    // Guards the mount itself. If a future compose edit drops the bind, every
    // backup fails at 4am with a ClickHouse error code and no context.
    //
    // Asked through chAdmin, not ch: system.disks is global, and the test
    // above leaves `lyraflow` dropped if it fails between its DROP and its
    // RESTORE. Bound to that database, this test would then report
    // "Database lyraflow does not exist" — burying the one diagnostic it
    // exists to produce under a cascade from an unrelated failure.
    const disks = await chAdmin.query({
      query: 'SELECT name FROM system.disks',
      format: 'JSONEachRow',
    })
    expect((await disks.json()).map((r: { name: string }) => r.name)).toContain('backups')
  })
})
