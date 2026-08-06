import { createHash } from 'node:crypto'
import type { Pool } from '@lyraflow/db'

export interface Project {
  id: number
  slug: string
  retentionMonths: number
  monthlyEventQuota: number
}

interface Entry {
  value: Project | null
  fetchedAt: number
}

export function hashServerKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * THREAT: the ingest port is published to the internet and authenticated by a
 * write key that is public by design, so *anyone* can make this cache store an
 * entry simply by sending an unknown key — a miss caches `{ value: null }` and
 * answers 401. Unbounded, a scanner walking random `x-lyraflow-write-key`
 * values grows the map monotonically and costs one uncoalesced Postgres round
 * trip per distinct key against a `max: 10` pool. Sustained, that is pool
 * starvation or an OOM kill — and an OOM kill destroys every event IngestBuffer
 * is holding, which is precisely the loss IngestBuffer's `maxRows` bound exists
 * to prevent. The event path is bounded; the auth path in front of it must be
 * too.
 *
 * Positive and negative answers are therefore kept in *separate* bounded maps.
 * Hostile traffic can only ever produce negative entries, so giving them their
 * own (small) budget means they can never evict a real project, no matter how
 * many bad keys arrive. Negative entries also get a shorter TTL: their only job
 * is to stop a repeated bad key becoming a query flood, and they are the
 * cheapest thing in the cache to discard.
 */
export const MAX_POSITIVE_ENTRIES = 1000
export const MAX_NEGATIVE_ENTRIES = 128
export const NEGATIVE_TTL_MS = 10_000

interface CacheStats {
  queries: number
  positiveEntries: number
  negativeEntries: number
}

/**
 * Resolves keys to projects, keeping the last known answer so that a Postgres
 * outage degrades the dashboard without stopping event collection — which is
 * the spec's stated priority.
 *
 * Both maps are LRU-bounded: `Map` iterates in insertion order and every read
 * re-inserts its entry, so the first key is always the least recently used.
 */
export class ProjectCache {
  #positive = new Map<string, Entry>()
  #negative = new Map<string, Entry>()
  #queries = 0
  readonly #negativeTtlMs: number

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number,
    // Overridable so a test can prove the two TTLs are genuinely separate
    // without sleeping for the production value. Production uses the default.
    negativeTtlMs: number = NEGATIVE_TTL_MS,
  ) {
    // Never longer than the positive TTL: a negative answer is the one an
    // attacker controls, so it must not be the longer-lived of the two.
    this.#negativeTtlMs = Math.min(ttlMs, negativeTtlMs)
  }

  get stats(): CacheStats {
    return {
      queries: this.#queries,
      positiveEntries: this.#positive.size,
      negativeEntries: this.#negative.size,
    }
  }

  invalidate(): void {
    this.#positive.clear()
    this.#negative.clear()
  }

  byWriteKey(key: string): Promise<Project | null> {
    return this.#lookup(`w:${key}`, 'write_key = $1', key)
  }

  byServerKey(key: string): Promise<Project | null> {
    return this.#lookup(`s:${key}`, 'server_key_hash = $1', hashServerKey(key))
  }

  /** Reads an entry from whichever map holds it, refreshing its LRU position. */
  #read(cacheKey: string): { value: Project | null; fresh: boolean } | undefined {
    const positive = this.#positive.get(cacheKey)
    if (positive) {
      this.#positive.delete(cacheKey)
      this.#positive.set(cacheKey, positive)
      return { value: positive.value, fresh: Date.now() - positive.fetchedAt < this.ttlMs }
    }
    const negative = this.#negative.get(cacheKey)
    if (negative) {
      this.#negative.delete(cacheKey)
      this.#negative.set(cacheKey, negative)
      return { value: negative.value, fresh: Date.now() - negative.fetchedAt < this.#negativeTtlMs }
    }
    return undefined
  }

  #store(cacheKey: string, value: Project | null): void {
    const target = value ? this.#positive : this.#negative
    const other = value ? this.#negative : this.#positive
    const cap = value ? MAX_POSITIVE_ENTRIES : MAX_NEGATIVE_ENTRIES

    // A key that changed sides (project deleted, or a key re-issued) must not
    // be left behind in the other map, where #read would still find it.
    other.delete(cacheKey)
    // Re-inserting moves the key to the end of the LRU order.
    target.delete(cacheKey)
    while (target.size >= cap) {
      const oldest = target.keys().next().value
      if (oldest === undefined) break
      target.delete(oldest)
    }
    target.set(cacheKey, { value, fetchedAt: Date.now() })
  }

  async #lookup(cacheKey: string, where: string, param: string): Promise<Project | null> {
    const hit = this.#read(cacheKey)
    if (hit?.fresh) return hit.value

    try {
      this.#queries++
      const res = await this.pool.query<{
        id: string
        slug: string
        retention_months: number
        monthly_event_quota: string
      }>(`SELECT id, slug, retention_months, monthly_event_quota FROM projects WHERE ${where}`, [
        param,
      ])
      const row = res.rows[0]
      const value: Project | null = row
        ? {
            id: Number(row.id),
            slug: row.slug,
            retentionMonths: row.retention_months,
            monthlyEventQuota: Number(row.monthly_event_quota),
          }
        : null
      this.#store(cacheKey, value)
      return value
    } catch (err) {
      // Stale beats unavailable: keep collecting events on the last known answer.
      if (hit) return hit.value
      throw err
    }
  }
}
