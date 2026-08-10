import type { Pool } from '@lyraflow/db'

type Kind = 'accepted' | 'rejected' | 'throttled' | 'over_quota'

interface Tally {
  accepted: number
  rejected: number
  throttled: number
  over_quota: number
}

/**
 * The 'YYYY-MM-01' key every counter write and every counter read is scoped
 * by. Exported because the quota check in ingest/routes.ts caches a
 * project's persisted total and has to know when that cached figure belongs
 * to a month that has since rolled over — a second, private copy of this
 * expression there is exactly the drift that would make the cache and the
 * rows it summarises disagree for one TTL every month.
 */
export function currentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`
}

/** The project-month whose write failed, and the counts that were re-buffered for retry. */
export interface CounterFailure {
  projectId: number
  month: string
  tally: Readonly<Tally>
}

/**
 * Accumulates ingest outcomes in memory and folds them into Postgres
 * periodically. Silent throttling is indistinguishable from a broken
 * integration, so these numbers are surfaced in the UI and as metrics.
 */
export class IngestCounters {
  #tallies = new Map<string, { projectId: number; month: string; tally: Tally }>()

  // Cumulative since process start, deliberately never touched by flush().
  // #tallies above is a *pending-write* buffer: flush() drains and clears it
  // on every successful (or re-buffered) round trip to Postgres, so it can't
  // serve as a Prometheus counter — a metric built on it would reset every
  // ~10s instead of only on process restart, which is not what a `_total`
  // counter means. This field is that separate, monotonic record.
  #totals: Tally = { accepted: 0, rejected: 0, throttled: 0, over_quota: 0 }

  constructor(
    private readonly pool: Pool,
    private readonly onError?: (err: unknown, failed: CounterFailure) => void,
  ) {}

  record(projectId: number, kind: Kind, n = 1): void {
    const month = currentMonth()
    this.#getOrCreate(projectId, month)[kind] += n
    this.#totals[kind] += n
  }

  /** Cumulative event outcomes since process start, for the `/metrics` endpoint. */
  totals(): Readonly<Tally> {
    return { ...this.#totals }
  }

  /**
   * events_accepted already in Postgres for this project's current month.
   * Zero for a project with no counter row yet -- the ordinary state for
   * every project's first event of a month -- never NaN. A quota check
   * feeds this straight into isOverQuota(), which throws on anything that
   * isn't a finite, non-negative number; `Number(row?.events_accepted)` on a
   * missing row would be exactly NaN, and `pg` returns bigint columns as
   * strings, so both traps are guarded against explicitly here rather than
   * left to the caller.
   */
  async persistedAccepted(projectId: number): Promise<number> {
    const month = currentMonth()
    const result = await this.pool.query<{ events_accepted: string }>(
      'SELECT events_accepted FROM ingest_counters WHERE project_id = $1 AND month = $2',
      [projectId, month],
    )
    const raw = result.rows[0]?.events_accepted
    return raw === undefined ? 0 : Number(raw)
  }

  /**
   * This process's unflushed accepted tally for this project's current
   * month -- reads #tallies (the pending-write buffer), never #totals (the
   * monotonic since-process-start record). #totals already includes events
   * that flush() has persisted, so adding it to the persisted figure would
   * double-count every already-flushed event. Only 'accepted' counts:
   * rejected and throttled events must never move a project toward its
   * quota (see quota.ts), or a flood of malformed payloads exhausts it
   * without storing anything.
   */
  pendingAccepted(projectId: number): number {
    const month = currentMonth()
    return this.#tallies.get(`${projectId}:${month}`)?.tally.accepted ?? 0
  }

  /**
   * Every pending project-month is attempted, even if an earlier one fails —
   * one bad write must not silently abandon the rest. A failed write is
   * folded back into the in-memory tally (merged with anything recorded in
   * the meantime, not overwriting it) so the next flush() retries it instead
   * of losing the counts.
   *
   * flush() itself never rejects. It's called fire-and-forget from a
   * `setInterval` and awaited bare on a shutdown drain (see Task 12); an
   * unhandled rejection there would, on this repo's pinned Node version,
   * terminate the process — losing every event still held in IngestBuffer,
   * not just these counters. That blast radius is far worse than the
   * problem a rejection would have reported, so failures are surfaced
   * through `onError` instead, mirroring the contract IngestBuffer already
   * established for the same reason.
   */
  async flush(): Promise<void> {
    if (this.#tallies.size === 0) return
    const pending = [...this.#tallies.values()]
    this.#tallies.clear()

    for (const { projectId, month, tally } of pending) {
      try {
        await this.pool.query(
          `INSERT INTO ingest_counters
             (project_id, month, events_accepted, events_rejected, events_throttled, events_over_quota)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (project_id, month) DO UPDATE SET
             events_accepted   = ingest_counters.events_accepted   + EXCLUDED.events_accepted,
             events_rejected   = ingest_counters.events_rejected   + EXCLUDED.events_rejected,
             events_throttled  = ingest_counters.events_throttled  + EXCLUDED.events_throttled,
             events_over_quota = ingest_counters.events_over_quota + EXCLUDED.events_over_quota`,
          [projectId, month, tally.accepted, tally.rejected, tally.throttled, tally.over_quota],
        )
      } catch (err) {
        const target = this.#getOrCreate(projectId, month)
        target.accepted += tally.accepted
        target.rejected += tally.rejected
        target.throttled += tally.throttled
        target.over_quota += tally.over_quota
        try {
          // A throwing onError must not crash the process via an unhandled
          // rejection from a fire-and-forget flush — that's a bug in the
          // caller's error handler, not a reason to lose the durability
          // guarantee.
          this.onError?.(err, { projectId, month, tally })
        } catch {
          // Deliberately swallowed — see above.
        }
      }
    }
  }

  #getOrCreate(projectId: number, month: string): Tally {
    const key = `${projectId}:${month}`
    let entry = this.#tallies.get(key)
    if (!entry) {
      entry = { projectId, month, tally: { accepted: 0, rejected: 0, throttled: 0, over_quota: 0 } }
      this.#tallies.set(key, entry)
    }
    return entry.tally
  }
}
