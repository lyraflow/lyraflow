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
    const key = `${projectId}:${month}`
    let entry = this.#tallies.get(key)
    if (!entry) {
      entry = { projectId, month, tally: { accepted: 0, rejected: 0, throttled: 0 } }
      this.#tallies.set(key, entry)
    }
    entry.tally[kind] += n
  }

  async flush(): Promise<void> {
    if (this.#tallies.size === 0) return
    const pending = [...this.#tallies.values()]
    this.#tallies.clear()

    for (const { projectId, month, tally } of pending) {
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
    }
  }
}
