import type { Pool } from '@lyraflow/db'

/**
 * Test-only helpers for reading and seeding `ingest_counters` rows.
 *
 * They live here rather than inside one test file because two suites now
 * need them — counters.test.ts, which owns the table's behaviour, and
 * ingest/routes.test.ts, whose quota tests assert on the row a request path
 * produced. A second private copy in the second file is the shape that
 * drifts: the day a column is added, one copy learns about it and the other
 * keeps passing while asserting on a row it no longer fully reads.
 *
 * The pool is a parameter rather than a module-level connection: each test
 * file owns its own pool and closes it in its own `afterAll`, and a pool
 * created here would outlive whichever file happened to end first.
 */

export interface CounterRow {
  events_accepted: string
  events_rejected: string
  events_throttled: string
  events_over_quota: string
}

/**
 * The counter row for a project's current month. Throws rather than
 * returning undefined: every caller asserts on the row's contents, and a
 * missing row is a fixture that did not do what the test assumed — which is
 * far more useful as a named failure than as `expect(undefined?.x)`.
 */
export async function readCounterRow(pg: Pool, projectId: number): Promise<CounterRow> {
  const month = `${new Date().toISOString().slice(0, 7)}-01`
  const r = await pg.query<CounterRow>(
    `SELECT events_accepted, events_rejected, events_throttled, events_over_quota
       FROM ingest_counters WHERE project_id = $1 AND month = $2`,
    [projectId, month],
  )
  const row = r.rows[0]
  if (!row) throw new Error(`no counter row for project ${projectId}, month ${month}`)
  return row
}

/**
 * Overwrites (not adds to) the row for project+month, so a test can pin an
 * exact starting total regardless of what an earlier test did.
 */
export async function seedCounterRow(
  pg: Pool,
  projectId: number,
  month: string,
  counts: { accepted?: number; rejected?: number; throttled?: number; over_quota?: number },
): Promise<void> {
  await pg.query(
    `INSERT INTO ingest_counters
         (project_id, month, events_accepted, events_rejected, events_throttled, events_over_quota)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, month) DO UPDATE SET
         events_accepted   = EXCLUDED.events_accepted,
         events_rejected   = EXCLUDED.events_rejected,
         events_throttled  = EXCLUDED.events_throttled,
         events_over_quota = EXCLUDED.events_over_quota`,
    [
      projectId,
      month,
      counts.accepted ?? 0,
      counts.rejected ?? 0,
      counts.throttled ?? 0,
      counts.over_quota ?? 0,
    ],
  )
}

/**
 * offset 0 is the current month, -1 the one before it, both expressed as the
 * same 'YYYY-MM-01' shape `record()` and the readers key on.
 */
export function monthStart(offset: number): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 10)
}
