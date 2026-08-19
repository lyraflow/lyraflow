import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { monthStart, readCounterRow, seedCounterRow } from './counter-fixtures.js'
import { IngestCounters } from './counters.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
let projectId: number

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['counters-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Counters', 'counters-test', 'wk_counters', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['counters-test'])
  await pg.end()
  await ch.close()
})

describe('IngestCounters', () => {
  it('accumulates in memory and writes one row per project and month', async () => {
    const c = new IngestCounters(pg)
    c.record(projectId, 'accepted', 5)
    c.record(projectId, 'accepted', 3)
    c.record(projectId, 'rejected')
    await c.flush()

    const r = await pg.query<{ events_accepted: string; events_rejected: string }>(
      'SELECT events_accepted, events_rejected FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    expect(Number(r.rows[0]?.events_accepted)).toBe(8)
    expect(Number(r.rows[0]?.events_rejected)).toBe(1)
  })

  it('adds to the existing row on a later flush rather than replacing it', async () => {
    const c = new IngestCounters(pg)
    c.record(projectId, 'accepted', 2)
    await c.flush()
    const r = await pg.query<{ events_accepted: string }>(
      'SELECT events_accepted FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    expect(Number(r.rows[0]?.events_accepted)).toBe(10)
  })

  it('is a no-op when nothing was recorded', async () => {
    const c = new IngestCounters(pg)
    await expect(c.flush()).resolves.toBeUndefined()
  })

  it('re-buffers a failed write so a later successful flush still persists it, surfacing the failure via onError instead of rejecting', async () => {
    // Minimal fake satisfying only the `query` method IngestCounters calls;
    // cast through `unknown` since it doesn't implement pg's full Pool
    // surface. The first call fails to simulate a DB blip; later calls
    // forward to the real pool so the retry can actually land in Postgres.
    let shouldFail = true
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (shouldFail) {
          shouldFail = false
          return Promise.reject(new Error('connection reset'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    const errors: unknown[] = []
    const c = new IngestCounters(flaky, (err) => errors.push(err))
    c.record(projectId, 'accepted', 4)

    // flush() must never reject — it's called fire-and-forget from a
    // setInterval and awaited bare on a shutdown drain, so a rejection here
    // would become an unhandled rejection and, on this repo's pinned Node
    // version, terminate the process (losing every buffered event, not just
    // these counters). Failure is observed through onError instead.
    await expect(c.flush()).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)

    // Recording again before the retry proves the re-buffered tally merges
    // with new activity rather than being discarded or overwritten by it.
    c.record(projectId, 'accepted', 1)
    await c.flush()
    expect(errors).toHaveLength(1) // the retry succeeds; no second failure

    const r = await pg.query<{ events_accepted: string }>(
      'SELECT events_accepted FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    // 10 from the two earlier tests, plus the re-buffered 4, plus the 1
    // recorded during the outage window: 15.
    expect(Number(r.rows[0]?.events_accepted)).toBe(15)
  })

  it('flush settles normally even if onError itself throws', async () => {
    const c = new IngestCounters(
      { query: () => Promise.reject(new Error('connection reset')) } as unknown as Pool,
      () => {
        throw new Error('logging backend also down')
      },
    )
    c.record(projectId, 'accepted', 1)
    await expect(c.flush()).resolves.toBeUndefined()
  })

  it('tallies bot drops apart from rejections', async () => {
    const counters = new IngestCounters(pg)
    counters.record(1, 'bot')
    counters.record(1, 'rejected')
    expect(counters.totals().bot).toBe(1)
    expect(counters.totals().rejected).toBe(1)
  })
})

describe('IngestCounters persisted/pending reads', () => {
  // A dedicated project, distinct from the describe block above, and reset
  // between tests: `persistedAccepted`/`pendingAccepted` assertions below
  // check exact totals (`toBe(40)`, `toBe(5)`), which only hold if nothing
  // else in this file has written to this project-month first.
  let projectId: number
  let unusedProjectId: number

  // readCounterRow/seedCounterRow/monthStart moved to counter-fixtures.ts
  // when ingest/routes.test.ts's quota tests needed them too — see that
  // file's header for why a second copy there was the wrong answer.

  beforeAll(async () => {
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
      ['counters-quota-test', 'counters-quota-unused'],
    ])
    const a = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Counters Quota', 'counters-quota-test', 'wk_counters_quota', 'h') RETURNING id`,
    )
    projectId = Number(a.rows[0]?.id)
    const u = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Counters Quota Unused', 'counters-quota-unused', 'wk_counters_quota_unused', 'h')
       RETURNING id`,
    )
    unusedProjectId = Number(u.rows[0]?.id)
  })

  beforeEach(async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = $1', [projectId])
  })

  afterAll(async () => {
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
      ['counters-quota-test', 'counters-quota-unused'],
    ])
  })

  it('records over_quota separately from throttled', async () => {
    // Conflating them would leave an operator unable to tell "I am overloaded"
    // from "I am over budget" -- which need opposite responses.
    const counters = new IngestCounters(pg)
    counters.record(projectId, 'over_quota')
    counters.record(projectId, 'throttled', 2)
    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_over_quota).toBe('1')
    expect(row.events_throttled).toBe('2')
  })

  it('reads the persisted accepted total for the current month only', async () => {
    const counters = new IngestCounters(pg)
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 40 })
    await seedCounterRow(pg, projectId, monthStart(-1), { accepted: 999 })
    expect(await counters.persistedAccepted(projectId)).toBe(40)
  })

  it('returns zero persisted for a project with no row yet', async () => {
    const counters = new IngestCounters(pg)
    expect(await counters.persistedAccepted(unusedProjectId)).toBe(0)
  })

  it('pendingAccepted counts only what has not been flushed', async () => {
    // #totals is monotonic since process start; #tallies is the pending-write
    // buffer. Adding #totals to the persisted figure would count every already
    // -flushed event twice, so a project would hit its quota at half of it.
    const counters = new IngestCounters(pg)
    counters.record(projectId, 'accepted', 5)
    expect(counters.pendingAccepted(projectId)).toBe(5)
    await counters.flush()
    expect(counters.pendingAccepted(projectId)).toBe(0)
    expect(await counters.persistedAccepted(projectId)).toBe(5)
  })

  it('pendingAccepted ignores other kinds', async () => {
    // The security property: rejected and throttled events must never move a
    // project toward its quota, or a flood of malformed payloads exhausts it
    // without storing anything.
    const counters = new IngestCounters(pg)
    counters.record(projectId, 'rejected', 100)
    counters.record(projectId, 'throttled', 100)
    counters.record(projectId, 'over_quota', 100)
    expect(counters.pendingAccepted(projectId)).toBe(0)
  })

  // Not in the brief. The re-buffer path (flush()'s catch block, exercised
  // elsewhere only with 'accepted') has three other fields it must carry
  // across a failed write the same way -- a mutation that dropped
  // `target.over_quota += tally.over_quota` there passed every prescribed
  // test and the four above. See task-3-report.md for the failure this
  // closes.
  it('re-buffers over_quota, not only accepted, so a retried flush still persists it', async () => {
    let shouldFail = true
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (shouldFail) {
          shouldFail = false
          return Promise.reject(new Error('connection reset'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    const counters = new IngestCounters(flaky)
    counters.record(projectId, 'over_quota', 3)
    await counters.flush() // fails; over_quota must be re-buffered, not dropped
    await counters.flush() // retries against the real pool
    const row = await readCounterRow(pg, projectId)
    expect(row.events_over_quota).toBe('3')
  })

  // Not in the brief. `over_quota`'s accumulate-on-conflict clause in
  // flush()'s INSERT ... ON CONFLICT DO UPDATE SET had no test: every test
  // above starts from a beforeEach-cleared row, so every successful flush()
  // in this file takes the plain-INSERT path for over_quota, never the
  // conflict path. Mirrors 'adds to the existing row on a later flush rather
  // than replacing it' above, which covers exactly this for `accepted`.
  it('adds over_quota to the existing row on a later flush rather than replacing it', async () => {
    const counters = new IngestCounters(pg)
    counters.record(projectId, 'over_quota', 4)
    await counters.flush()
    counters.record(projectId, 'over_quota', 3)
    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_over_quota).toBe('7')
  })

  // Not in the brief. persistedAccepted has an explicit current-month-only
  // test; pendingAccepted had no equivalent -- nothing proved it keys the
  // #tallies lookup by month rather than summing every buffered month for
  // the project. Fake time to buffer one month's tally, advance past a
  // month boundary without flushing, and buffer a second month's tally:
  // pendingAccepted must report only the second.
  it('pendingAccepted counts only the current month, not a carried-over one', () => {
    const counters = new IngestCounters(pg)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2020, 0, 15)))
      counters.record(projectId, 'accepted', 7) // buffered under Jan 2020, never flushed
      vi.setSystemTime(new Date(Date.UTC(2020, 1, 15))) // now Feb 2020
      counters.record(projectId, 'accepted', 2)
      expect(counters.pendingAccepted(projectId)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
