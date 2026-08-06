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
 * Resolves keys to projects, keeping the last known answer so that a Postgres
 * outage degrades the dashboard without stopping event collection — which is
 * the spec's stated priority.
 */
export class ProjectCache {
  #entries = new Map<string, Entry>()
  #queries = 0

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number,
  ) {}

  get stats(): { queries: number } {
    return { queries: this.#queries }
  }

  invalidate(): void {
    this.#entries.clear()
  }

  byWriteKey(key: string): Promise<Project | null> {
    return this.#lookup(`w:${key}`, 'write_key = $1', key)
  }

  byServerKey(key: string): Promise<Project | null> {
    return this.#lookup(`s:${key}`, 'server_key_hash = $1', hashServerKey(key))
  }

  async #lookup(cacheKey: string, where: string, param: string): Promise<Project | null> {
    const hit = this.#entries.get(cacheKey)
    const fresh = hit && Date.now() - hit.fetchedAt < this.ttlMs
    if (hit && fresh) return hit.value

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
      this.#entries.set(cacheKey, { value, fetchedAt: Date.now() })
      return value
    } catch (err) {
      // Stale beats unavailable: keep collecting events on the last known answer.
      if (hit) return hit.value
      throw err
    }
  }
}
