import type { Pool } from '@lyraflow/db'

type Kind = 'accepted' | 'rejected' | 'throttled'

interface Tally {
  accepted: number
  rejected: number
  throttled: number
}

/**
 * Accumulates ingest outcomes in memory and folds them into Postgres
 * periodically. Silent throttling is indistinguishable from a broken
 * integration, so these numbers are surfaced in the UI and as metrics.
 */
export class IngestCounters {
  #tallies = new Map<string, { projectId: number; month: string; tally: Tally }>()

  constructor(private readonly pool: Pool) {}

  record(projectId: number, kind: Kind, n = 1): void {
    const month = `${new Date().toISOString().slice(0, 7)}-01`
    this.#getOrCreate(projectId, month)[kind] += n
  }

  /**
   * Every pending project-month is attempted, even if an earlier one fails —
   * one bad write must not silently abandon the rest. A failed write is
   * folded back into the in-memory tally (merged with anything recorded in
   * the meantime, not overwriting it) so the next flush() retries it instead
   * of losing the counts. If anything failed, flush() rejects at the end so
   * the caller can observe and log it — the counts themselves are never
   * silently dropped, only ever deferred to the next successful flush.
   */
  async flush(): Promise<void> {
    if (this.#tallies.size === 0) return
    const pending = [...this.#tallies.values()]
    this.#tallies.clear()

    const failures: unknown[] = []
    for (const { projectId, month, tally } of pending) {
      try {
        await this.pool.query(
          `INSERT INTO ingest_counters
             (project_id, month, events_accepted, events_rejected, events_throttled)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, month) DO UPDATE SET
             events_accepted  = ingest_counters.events_accepted  + EXCLUDED.events_accepted,
             events_rejected  = ingest_counters.events_rejected  + EXCLUDED.events_rejected,
             events_throttled = ingest_counters.events_throttled + EXCLUDED.events_throttled`,
          [projectId, month, tally.accepted, tally.rejected, tally.throttled],
        )
      } catch (err) {
        const target = this.#getOrCreate(projectId, month)
        target.accepted += tally.accepted
        target.rejected += tally.rejected
        target.throttled += tally.throttled
        failures.push(err)
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} of ${pending.length} ingest counter flush write(s) failed and were re-buffered for retry`,
      )
    }
  }

  #getOrCreate(projectId: number, month: string): Tally {
    const key = `${projectId}:${month}`
    let entry = this.#tallies.get(key)
    if (!entry) {
      entry = { projectId, month, tally: { accepted: 0, rejected: 0, throttled: 0 } }
      this.#tallies.set(key, entry)
    }
    return entry.tally
  }
}
