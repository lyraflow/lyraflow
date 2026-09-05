import { createChClient } from '@lyraflow/db'
import { afterAll, describe, expect, it } from 'vitest'
import { StatsQueryError, resolveStatsWindow, runStats } from './stats.js'

const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const deps = { ch, database: 'lyraflow_test' }
const NOW = new Date('2026-09-05T12:00:00.000Z')

afterAll(async () => {
  await ch.close()
})

describe('resolveStatsWindow', () => {
  it('defaults since from the interval window and until from now', () => {
    const w = resolveStatsWindow('1h', undefined, undefined, NOW)
    expect(w.until.toISOString()).toBe(NOW.toISOString())
    expect(w.since.toISOString()).toBe('2026-09-04T12:00:00.000Z')
  })
  it('keeps explicit bounds', () => {
    const since = new Date('2026-09-01T00:00:00.000Z')
    const until = new Date('2026-09-02T00:00:00.000Z')
    expect(resolveStatsWindow('1d', since, until, NOW)).toEqual({ since, until })
  })
})

describe('runStats', () => {
  it('refuses a window over the bucket ceiling before querying', async () => {
    const since = new Date('2025-09-05T12:00:00.000Z')
    await expect(
      runStats(deps, { id: 1 }, { since, until: NOW, interval: '1m', predicates: [] }),
    ).rejects.toMatchObject({ code: 'window_too_large' })
    await expect(
      runStats(deps, { id: 1 }, { since, until: NOW, interval: '1m', predicates: [] }),
    ).rejects.toBeInstanceOf(StatsQueryError)
  })

  it('returns an ungrouped page with no folded_series for an empty project', async () => {
    const body = await runStats(deps, { id: 999_999_999 }, { interval: '1d', predicates: [] })
    expect(body).toEqual({ buckets: [] })
  })
})
