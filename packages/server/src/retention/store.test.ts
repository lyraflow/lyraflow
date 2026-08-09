import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { retentionBoundary, toYYYYMM } from './boundary.js'
import { type DropResult, RETENTION_TABLES, RetentionStore, type RetentionTarget } from './store.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const SLUG_A = 'ret-store-a'
const SLUG_B = 'ret-store-b'

// Intended prefix `re000000-`, but `r` is not a hex digit: ClickHouse's UUID
// parser silently coerces it to `fe000000-` on insert (confirmed live --
// `SELECT event_id` reads back `fe000000-0000-...`, not `re000000-...`).
// Harmless here (still a fixed, file-local prefix, still distinct from every
// other suite's), but the REAL prefix a future suite must avoid colliding
// with is `fe000000-`, not `re000000-`.
let seedCounter = 0
const eventId = () => {
  seedCounter += 1
  return `re000000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`
}

let projectA: number
let projectB: number

/**
 * `dropOnePartition` is `protected`, not exported -- Guard 2 (assert at the
 * moment of the drop) is only provable by calling it directly with a
 * partition that was never filtered through `expiredPartitions`, so this
 * subclass exists purely to reach it from a test. Every other test in this
 * file uses a plain `RetentionStore`; only the boundary-month test below
 * needs this one.
 */
class ForcedDropStore extends RetentionStore {
  forceDrop(projectId: number, partition: number, boundaryMonth: number): Promise<DropResult> {
    return this.dropOnePartition(projectId, 'events', partition, boundaryMonth)
  }
}

/**
 * Proves `dropExpired` is NOT all-or-nothing across `RETENTION_TABLES` (see
 * that method's own docstring in store.ts) by injecting a failure into the
 * SECOND table only. `dropOnePartition` is `protected` specifically so
 * tests can subclass it -- `ForcedDropStore` above does this for Guard 2;
 * this does it to prove the partial-run behaviour directly, at zero risk,
 * rather than merely asserting it in prose. `RETENTION_TABLES` is
 * `['events', 'device_index']`, in that order, so `events`' real drop
 * completes before `device_index`'s own call ever throws.
 */
class FailSecondTableStore extends RetentionStore {
  protected override async dropOnePartition(
    projectId: number,
    table: string,
    partition: number,
    boundaryMonth: number,
  ): Promise<DropResult> {
    if (table === 'device_index') {
      throw new Error('injected ClickHouse failure on device_index')
    }
    return super.dropOnePartition(projectId, table, partition, boundaryMonth)
  }
}

async function dropWithForcedPartition(
  store: ForcedDropStore,
  projectId: number,
  partition: number,
  now: Date,
): Promise<DropResult> {
  const boundary = retentionBoundary(now, 13)
  return store.forceDrop(projectId, partition, toYYYYMM(boundary))
}

async function makeProject(slug: string, name: string, retentionMonths: number): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, retention_months)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_hash_${slug}`, retentionMonths],
  )
  return Number(r.rows[0]?.id)
}

/** ClickHouse DateTime64(3) literal from an ISO-8601 string. */
const chAt = (iso: string) => iso.replace('T', ' ').replace('Z', '')

async function seedEventAt(
  projectId: number,
  isoTimestamp: string,
  eventName: string,
): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: '',
        user_id: `ret-store-user-${seedCounter}`,
        event_name: eventName,
        timestamp: chAt(isoTimestamp),
        received_at: chAt(isoTimestamp),
        trusted: 1,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

async function eventNames(projectId: number): Promise<string[]> {
  const rs = await ch.query({
    query: 'SELECT event_name FROM events WHERE project_id = {p:UInt32} ORDER BY timestamp ASC',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ event_name: string }>()
  return rows.map((r) => r.event_name)
}

/** `device_index.month` as `YYYY-MM-DD` text, for the device_index-drop test. */
async function deviceIndexMonths(projectId: number): Promise<string[]> {
  const rs = await ch.query({
    query:
      'SELECT DISTINCT toString(month) AS month FROM device_index WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ month: string }>()
  return rows.map((r) => r.month)
}

/**
 * Drops every partition `projectId` currently has, in every retention table,
 * WITHOUT going through `RetentionStore`'s guards -- this is test-fixture
 * cleanup, not the code under test. Called at the top of every `it` (via
 * `beforeEach`) so each test starts from a project with zero ClickHouse
 * partitions, regardless of what an earlier test in this file inserted.
 * Reusing the same two Postgres project rows across the whole file only
 * works if ClickHouse state is wiped between tests, since ClickHouse has no
 * per-test transaction to roll back the way Postgres tests often do.
 */
async function wipeProjectPartitions(projectId: number): Promise<void> {
  for (const table of RETENTION_TABLES) {
    const rs = await ch.query({
      query: `SELECT DISTINCT partition FROM system.parts
              WHERE database = currentDatabase() AND table = {table:String} AND active`,
      query_params: { table },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ partition: string }>()
    for (const row of rows) {
      const match = /^\((\d+),(\d+)\)$/.exec(row.partition)
      if (!match) continue
      const [, projectIdText, monthText] = match
      if (Number(projectIdText) !== projectId) continue
      await ch.command({
        query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
        query_params: { p: projectId, m: Number(monthText) },
      })
    }
  }
}

/** `events_dead_letter` has no per-test wipe (only one test below writes to it). */
async function wipeDeadLetter(projectId: number): Promise<void> {
  await ch.command({
    query: 'ALTER TABLE events_dead_letter DELETE WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    clickhouse_settings: { mutations_sync: '1' },
  })
}

/**
 * Run at the TOP of beforeAll, not only in afterAll -- per the branch's
 * live-database rule, so a previous crashed run can never leave rows this
 * run trips over. Mirrors events/routes.test.ts's `cleanup()`.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  for (const id of ids) {
    await wipeProjectPartitions(id)
    await wipeDeadLetter(id)
  }
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

let store: ForcedDropStore

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  await cleanup()

  projectA = await makeProject(SLUG_A, 'RetentionStoreA', 13)
  projectB = await makeProject(SLUG_B, 'RetentionStoreB', 3)

  store = new ForcedDropStore({ pg, ch, dryRun: false })
})

beforeEach(async () => {
  await wipeProjectPartitions(projectA)
  await wipeProjectPartitions(projectB)
})

afterAll(async () => {
  await wipeProjectPartitions(projectA)
  await wipeProjectPartitions(projectB)
  await wipeDeadLetter(projectA)
  await wipeDeadLetter(projectB)
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
  await pg.end()
  await ch.close()
})

// Captured ONCE, from the REAL process clock, when this file loads --
// `dropExpired` now refuses any `now` more than a day from the real process
// clock (the fix for the clock-skew hole; see store.ts), so a fixed literal
// like '2026-08-01' would drift out of that window the moment the real date
// moves past it. Every fixture below is instead anchored RELATIVE to this
// one value via `monthsAgo`/`yyyymmAgo`/`monthStartAgo` -- N months before
// or at NOW's own month -- so the file keeps working regardless of which
// real date it happens to run on.
const NOW = new Date()

/**
 * ISO instant for the 15th of the month `n` months before NOW's month --
 * except when NOW's own real day-of-month is earlier than the 15th (true on
 * a real run for roughly half of every month), in which case the day is
 * clamped down to NOW's own day. Without the clamp, `monthsAgo(0)` (today's
 * month) would land on the 15th regardless of the real date, seeding a
 * timestamp up to two weeks in the FUTURE relative to the real process
 * clock whenever a run happens to land before the 15th -- harmless (the
 * current month is never expired either way) but needlessly odd for a
 * fixture that is supposed to represent "recent, real data."
 */
function monthsAgo(n: number): string {
  const day = Math.min(15, NOW.getUTCDate())
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, day)).toISOString()
}

/** `YYYYMM` for the month `n` months before NOW's month -- matches `monthsAgo(n)`'s own month. */
function yyyymmAgo(n: number): number {
  return toYYYYMM(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, 1)))
}

/** 'YYYY-MM-DD' for the 1st of the month `n` months before NOW's month -- matches `device_index.month`'s text format. */
function monthStartAgo(n: number): string {
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, 1))
    .toISOString()
    .slice(0, 10)
}

describe('RetentionStore', () => {
  it('drops only partitions strictly older than the boundary, and leaves the neighbour byte-intact', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    await seedEventAt(projectA, monthsAgo(13), 'boundary_evt')
    await seedEventAt(projectA, monthsAgo(0), 'recent_evt')

    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)

    expect(results.filter((r) => r.dropped).map((r) => r.partition)).toContain(yyyymmAgo(14))
    expect(await eventNames(projectA)).toEqual(['boundary_evt', 'recent_evt'])
  })

  it('refuses to drop a partition at the boundary month itself', async () => {
    await seedEventAt(projectA, monthsAgo(13), 'boundary_evt')
    await expect(dropWithForcedPartition(store, projectA, yyyymmAgo(13), NOW)).rejects.toThrow(
      /not older than retention boundary month/i,
    )
    expect(await eventNames(projectA)).toEqual(['boundary_evt'])
  })

  // ROUND 2: the "boundary can never be in the future" assertion this test
  // originally pinned has been REMOVED, not merely reworded -- see store.ts's
  // `dropExpired` docstring for the full reasoning, summarised here: once
  // `retentionMonths` is validated to an integer in [1, 120] (the range
  // check below), `retentionBoundary` subtracts at least one whole month
  // from `now`, so the resulting boundary can never be later than `now` --
  // BY CONSTRUCTION, not by a second runtime comparison. A dedicated
  // future-boundary assertion could therefore never independently fire once
  // this range check exists: proven by a reviewer swapping the two checks'
  // order and getting the identical failure set either way, with no row
  // assertion ever distinguishing them. A negative `retentionMonths` is
  // still refused -- just by the range check, with a message about the real
  // problem, not a message selected by a check that adds no protection of
  // its own.
  it('refuses a negative retentionMonths via the range check, not a dedicated future-boundary message', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: -1 }, NOW),
    ).rejects.toThrow(/retentionMonths -1 is not an integer/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('reclaims a dormant project whose partitions have all expired', async () => {
    // A churned account is exactly the population disk retention exists to
    // free. The old "never drop everything" rule refused this forever, and
    // a dormant project has no current-month partition to save it.
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.filter((r) => r.dropped).map((r) => r.partition)).toContain(yyyymmAgo(14))
    expect(await eventNames(projectA)).toEqual([])
  })

  // THE Critical fix. The old "never drop every partition" rule was, by
  // accident, the only thing standing between a skewed `now` and total
  // deletion: a `now` far in the future moves the boundary WITH it (the
  // boundary is COMPUTED FROM `now`), so no comparison between the boundary
  // and `now` itself -- including the removed future-boundary assertion
  // above -- can ever detect it. Confirmed live before this guard existed:
  // `retentionMonths: 13` (perfectly ordinary) with `now = 2099-01-01`
  // deleted every partition a project had, including the current month, no
  // throw. `now` is an injected seam on the scheduler's own options object
  // (see Task 3's brief), not only a broken-machine-clock story.
  //
  // Assert on ROWS, not the message. A message-only assertion would pass
  // against a version that throws for the wrong reason (e.g. the range
  // check catching an unrelated problem) and still deleted the data.
  it('refuses a `now` far from the process clock, which would drop everything', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    await seedEventAt(projectA, monthsAgo(0), 'recent_evt')
    await expect(
      store.dropExpired(
        { projectId: projectA, retentionMonths: 13 },
        new Date('2099-01-01T00:00:00Z'),
      ),
    ).rejects.toThrow(/clock/i)
    expect(await eventNames(projectA)).toEqual(['old_evt', 'recent_evt'])
  })

  // A dry run must be refused for exactly the same reason a real run would
  // be -- a preview that silently omitted "this run would in fact be
  // refused" misreports what a real run does.
  it('a dry run is also refused when `now` is far from the process clock', async () => {
    const dry = new RetentionStore({ pg, ch, dryRun: true })
    await seedEventAt(projectA, monthsAgo(14), 'only_evt')
    await expect(
      dry.dropExpired(
        { projectId: projectA, retentionMonths: 13 },
        new Date('2099-01-01T00:00:00Z'),
      ),
    ).rejects.toThrow(/clock/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('the clock-skew refusal names the project id, so a shared log line is attributable', async () => {
    await expect(
      store.dropExpired(
        { projectId: projectA, retentionMonths: 13 },
        new Date('2099-01-01T00:00:00Z'),
      ),
    ).rejects.toThrow(new RegExp(String(projectA)))
  })

  // The validity half of the clock check, not just the skew comparison.
  // `Invalid Date`'s `getTime()` is `NaN`, and `NaN > MAX_CLOCK_SKEW_MS` is
  // `false` -- a bare skew comparison lets it walk straight through,
  // producing an `Invalid Date` boundary that makes `expiredPartitions`
  // return `[]` unconditionally: a clean, silent, zero-drop "success" a
  // scheduler cannot tell from a healthy run. Same trap the
  // `retentionMonths` check defends against with `Number.isInteger`; the
  // `now` check must not reintroduce it. Two different ways to construct an
  // `Invalid Date`, since `now` is an injected seam that could arrive as
  // either shape -- a bad ISO-string parse (`new Date(process.env.X)`) or a
  // bad numeric epoch (`new Date(NaN)`).
  it('refuses an invalid `now` instead of silently dropping nothing', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    await seedEventAt(projectA, monthsAgo(0), 'keeper_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 13 }, new Date('not-a-date')),
    ).rejects.toThrow(/invalid/i)
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 13 }, new Date(Number.NaN)),
    ).rejects.toThrow(/invalid/i)
    expect(await eventNames(projectA)).toEqual(['old_evt', 'keeper_evt'])
  })

  // Pins the BOUND ITSELF, not just its direction. Every clock test above
  // uses a `now` decades out, which would pass unchanged for ANY
  // `MAX_CLOCK_SKEW_MS` from a day to seventy years -- widening the
  // constant later (a plausible "this keeps failing in CI, let me widen it"
  // edit) would go unnoticed by them. These two bracket the real 24-hour
  // bound tightly enough that only that exact value satisfies both.
  it('refuses a `now` just over 24 hours from the process clock', async () => {
    const justOver = new Date(Date.now() + 25 * 60 * 60 * 1000)
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 13 }, justOver),
    ).rejects.toThrow(/clock/i)
  })

  it('accepts a `now` just under 24 hours from the process clock', async () => {
    const justUnder = new Date(Date.now() + 23 * 60 * 60 * 1000)
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 13 }, justUnder),
    ).resolves.toBeDefined()
  })

  // Without this check, `retentionMonths: 0` does not "do nothing" --
  // `retentionBoundary` lands exactly on the current month, so a genuinely
  // old partition still compares as expired and gets dropped for real.
  it('refuses retentionMonths=0 instead of silently dropping real data', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 0 }, NOW),
    ).rejects.toThrow(/retentionMonths 0 is not an integer/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  // `dropExpired` takes an arbitrary `RetentionTarget`, not only ones read
  // through the Postgres column's `CHECK (retention_months BETWEEN 1 AND
  // 120)`. A non-finite value produces a boundary of `Invalid Date`, which
  // makes `expiredPartitions` return `[]` unconditionally -- a clean,
  // silent, zero-drop "success" a scheduler cannot distinguish from a
  // healthy run with nothing left to expire.
  it('refuses a non-finite retentionMonths instead of silently dropping nothing', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'only_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: Number.NaN }, NOW),
    ).rejects.toThrow(/retentionMonths NaN is not an integer/i)
    expect(await eventNames(projectA)).toEqual(['only_evt'])
  })

  it('accepts retentionMonths at both ends of the permitted range, 1 and 120, without a false refusal', async () => {
    await seedEventAt(projectA, monthsAgo(0), 'r1_evt')
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 1 }, NOW),
    ).resolves.toBeDefined()
    await expect(
      store.dropExpired({ projectId: projectA, retentionMonths: 120 }, NOW),
    ).resolves.toBeDefined()
    // Neither call had anything genuinely expired to drop (the fixture sits
    // in the current month), so the one row survives both.
    expect(await eventNames(projectA)).toEqual(['r1_evt'])
  })

  it('a dry run reports what it would drop and drops nothing', async () => {
    const dry = new RetentionStore({ pg, ch, dryRun: true })
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    const results = await dry.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.map((r) => r.partition)).toContain(yyyymmAgo(14))
    expect(results.every((r) => r.dropped === false)).toBe(true)
    expect(await eventNames(projectA)).toEqual(['old_evt'])
  })

  // `onDrop` (Guard 5's actual hook — see app.ts/logging.ts) is documented
  // to fire only for a REAL drop, never for a dry run's `dropped: false`
  // short-circuit -- there is no ALTER to be "immediately after". Proven
  // here directly against the store's real contract, not merely asserted
  // in `RetentionStoreOptions`' own docstring: a dry run must never call it,
  // even though it has real, genuinely expired partitions to report.
  it('never calls onDrop during a dry run, even when it has real expired partitions to report', async () => {
    const onDrop = vi.fn()
    const dry = new RetentionStore({ pg, ch, dryRun: true, onDrop })
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    const results = await dry.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results.length).toBeGreaterThan(0)
    expect(onDrop).not.toHaveBeenCalled()
    expect(await eventNames(projectA)).toEqual(['old_evt'])
  })

  it('calls onDrop once per REAL drop, with the exact same DropResult the caller gets back', async () => {
    const onDrop = vi.fn()
    const wired = new RetentionStore({ pg, ch, dryRun: false, onDrop })
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    const results = await wired.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    const realDrops = results.filter((r) => r.dropped)
    expect(realDrops.length).toBeGreaterThan(0)
    expect(onDrop).toHaveBeenCalledTimes(realDrops.length)
    for (const r of realDrops) {
      expect(onDrop).toHaveBeenCalledWith(r)
    }
  })

  // `onDrop`'s contract said nothing about a throwing handler, and the
  // answer is the OPPOSITE of `RetentionWorker`'s for its own handlers
  // (`#invokeHandler` swallows a throw and an async rejection alike). This
  // pins the difference live rather than leaving it to the new docstring:
  // the throw propagates, so the sweep stops where it threw and never
  // reaches `device_index` at all, while the partition already dropped
  // stays dropped.
  it('lets a throwing onDrop abort the rest of the project sweep, unlike the worker, which swallows its handlers', async () => {
    const seen: DropResult[] = []
    const wired = new RetentionStore({
      pg,
      ch,
      dryRun: false,
      onDrop: (r) => {
        seen.push(r)
        throw new Error('drop logger exploded')
      },
    })
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    expect(await deviceIndexMonths(projectA)).toContain(monthStartAgo(14))

    await expect(
      wired.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW),
    ).rejects.toThrow(/drop logger exploded/)

    // One call, on `events` — RETENTION_TABLES' first table. `device_index`
    // was never evaluated, which is the cost the docstring now names.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.table).toBe('events')
    expect(await eventNames(projectA)).toEqual([])
    expect(await deviceIndexMonths(projectA)).toContain(monthStartAgo(14))
  })

  it('never touches another project, even with an identical partition month', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'a_evt')
    await seedEventAt(projectB, monthsAgo(14), 'b_evt')
    await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(await eventNames(projectB)).toEqual(['b_evt'])
  })

  it('drops from device_index as well as events', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    expect(await deviceIndexMonths(projectA)).toContain(monthStartAgo(14))
    await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(await deviceIndexMonths(projectA)).not.toContain(monthStartAgo(14))
  })

  it('is idempotent — a second run drops nothing and does not throw', async () => {
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')
    await seedEventAt(projectA, monthsAgo(0), 'recent_evt')
    const first = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(first.filter((r) => r.dropped)).not.toHaveLength(0)
    const second = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(second.filter((r) => r.dropped)).toHaveLength(0)
    expect(await eventNames(projectA)).toEqual(['recent_evt'])
  })

  it('returns every project with its own retention_months', async () => {
    const targets = await store.listProjects()
    const a = targets.find((t: RetentionTarget) => t.projectId === projectA)
    const b = targets.find((t: RetentionTarget) => t.projectId === projectB)
    expect(a?.retentionMonths).toBe(13)
    expect(b?.retentionMonths).toBe(3)
  })

  // Regression test for the old "never drop everything" guard's other
  // failure: it compared `expired.length === allPartitions.length`, which is
  // `0 === 0` -- true -- for a brand-new project with zero partitions in a
  // table. Brand-new projects are routine, and Task 3 iterates every
  // project, so this must never throw. The redesigned checks depend on
  // neither the partition list nor its length, so this now simply does
  // nothing and returns cleanly.
  it('does not refuse a project with zero partitions in any retention table', async () => {
    const results = await store.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW)
    expect(results).toEqual([])
  })

  // `dropExpired` is NOT all-or-nothing across `RETENTION_TABLES` -- see the
  // docstring's own claim, proven here rather than merely asserted. Uses
  // `FailSecondTableStore` (see above) to inject a real failure on the
  // SECOND table only, at zero risk to shared infrastructure: no ClickHouse
  // error is actually forced, just a plain thrown Error from the override,
  // which `dropExpired`'s per-table loop propagates exactly as it would a
  // genuine `ALTER TABLE` failure.
  it('is not all-or-nothing across RETENTION_TABLES: a later table failing leaves an earlier drop in place', async () => {
    const failing = new FailSecondTableStore({ pg, ch, dryRun: false })
    await seedEventAt(projectA, monthsAgo(14), 'old_evt')

    await expect(
      failing.dropExpired({ projectId: projectA, retentionMonths: 13 }, NOW),
    ).rejects.toThrow(/injected ClickHouse failure/)

    // events (processed first, per RETENTION_TABLES' own order) already,
    // irreversibly, dropped its expired partition before device_index's own
    // call ever threw -- the exact shape the docstring warns callers about.
    expect(await eventNames(projectA)).toEqual([])
    expect(await deviceIndexMonths(projectA)).toContain(monthStartAgo(14))
  })

  // `listPartitions` scopes its `system.parts` query to `currentDatabase()`
  // because that table is server-wide, not scoped to the client's own
  // database. A second database on the same server, with its own same-named
  // `events` table using the identical `(project_id, month)` partition
  // shape, is exactly the case that filter exists to exclude -- without it,
  // a foreign database's row for this project would inflate the partition
  // list this store believes it has. Not clock-dependent (this calls
  // `listPartitions` directly, never `dropExpired`), so the fixture date
  // stays a plain literal.
  it('does not let a same-named table in a foreign database inflate the partition list', async () => {
    const foreignDb = 'ret_store_foreign_probe'
    await ch.command({ query: `CREATE DATABASE IF NOT EXISTS ${foreignDb}` })
    try {
      await ch.command({
        query: `CREATE TABLE IF NOT EXISTS ${foreignDb}.events (
                  project_id UInt32, ts DateTime64(3, 'UTC')
                ) ENGINE = MergeTree
                PARTITION BY (project_id, toYYYYMM(ts))
                ORDER BY (project_id, ts)`,
      })
      // A month with no real local counterpart for projectA, so its
      // presence (or absence) in the result is unambiguous.
      await ch.insert({
        table: `${foreignDb}.events`,
        format: 'JSONEachRow',
        values: [{ project_id: projectA, ts: chAt('2020-01-15T00:00:00Z') }],
      })

      const months = await store.listPartitions(projectA, 'events')
      expect(months).not.toContain(202001)
    } finally {
      await ch.command({ query: `DROP TABLE IF EXISTS ${foreignDb}.events` })
      await ch.command({ query: `DROP DATABASE IF EXISTS ${foreignDb}` })
    }
  })

  // `events_dead_letter` (`PARTITION BY toYYYYMM(received_at)`) is the one
  // table on the server with a SINGLE-column partition key, so
  // `system.parts.partition` renders it as a bare `"202401"`, not the
  // `"(project_id,month)"` tuple form every `RETENTION_TABLES` entry uses.
  // `listPartitions` must throw on that shape, not silently skip it: a
  // skipped row makes `listPartitions` under-report a project's true
  // partition set, and there is no downstream guard left that would ever
  // notice the shortfall. Not clock-dependent (calls `listPartitions`
  // directly), so the fixture date stays a plain literal.
  it('throws rather than silently skipping an unparseable partition value', async () => {
    await ch.insert({
      table: 'events_dead_letter',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          received_at: chAt('2024-01-15T00:00:00Z'),
          reason: 'ret_store_probe',
          detail: '',
          payload: '',
        },
      ],
    })
    await expect(store.listPartitions(projectA, 'events_dead_letter')).rejects.toThrow(
      /unexpected partition format/i,
    )
  })
})
