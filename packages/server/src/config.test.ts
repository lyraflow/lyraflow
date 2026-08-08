import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const required = {
  LYRAFLOW_POSTGRES_URL: 'postgres://u:p@localhost:5432/db',
  LYRAFLOW_CLICKHOUSE_URL: 'http://localhost:8123',
  LYRAFLOW_CLICKHOUSE_USER: 'u',
  LYRAFLOW_CLICKHOUSE_PASSWORD: 'p',
  LYRAFLOW_CLICKHOUSE_DB: 'lyraflow',
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({ ...required } as NodeJS.ProcessEnv)
    expect(c.port).toBe(3000)
    expect(c.flushIntervalMs).toBe(1000)
    expect(c.flushRows).toBe(1000)
    expect(c.drainDeadlineMs).toBe(25_000)
    expect(c.purgeIntervalMs).toBe(15_000)
    expect(c.purgeLeaseMs).toBe(600_000)
    expect(c.purgeMaxAttempts).toBe(5)
  })

  it('throws a named error listing every missing variable at once', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(
      /LYRAFLOW_POSTGRES_URL.*LYRAFLOW_CLICKHOUSE_URL/s,
    )
  })

  it('rejects a drain deadline that exceeds the compose stop grace period', () => {
    expect(() =>
      loadConfig({ ...required, LYRAFLOW_DRAIN_DEADLINE_MS: '60000' } as NodeJS.ProcessEnv),
    ).toThrow(/stop_grace_period/i)
  })

  it('overrides the purge worker settings from the environment', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_PURGE_INTERVAL_MS: '5000',
      LYRAFLOW_PURGE_LEASE_MS: '120000',
      LYRAFLOW_PURGE_MAX_ATTEMPTS: '3',
    } as NodeJS.ProcessEnv)
    expect(c.purgeIntervalMs).toBe(5000)
    expect(c.purgeLeaseMs).toBe(120_000)
    expect(c.purgeMaxAttempts).toBe(3)
  })

  it("throws through num's own message for a non-numeric purgeMaxAttempts", () => {
    expect(() =>
      loadConfig({
        ...required,
        LYRAFLOW_PURGE_MAX_ATTEMPTS: 'not-a-number',
      } as NodeJS.ProcessEnv),
    ).toThrow(/LYRAFLOW_PURGE_MAX_ATTEMPTS must be a number, got "not-a-number"/)
  })
})
