import { describe, expect, it } from 'vitest'
import { CLAIM_DELAY_MARGIN_MS, loadConfig } from './config.js'

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
    expect(c.retentionIntervalMs).toBe(3_600_000)
    expect(c.retentionEnabled).toBe(true)
    expect(c.projectCacheTtlMs).toBe(60_000)
    expect(c.projectPurgeClaimDelayMs).toBe(66_000)
  })

  /**
   * The claim delay is DERIVED, and the derivation is what stops the two
   * numbers drifting: turn the project cache's TTL up and the window a purge
   * must wait out has to follow it, or a purge starts while a cached project
   * row still says the project is live. There is deliberately no
   * `LYRAFLOW_PROJECT_PURGE_CLAIM_DELAY_MS` to set independently.
   */
  it('derives the purge claim delay from the cache TTL and the flush interval', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_PROJECT_CACHE_TTL_MS: '20000',
      LYRAFLOW_FLUSH_INTERVAL_MS: '2000',
    } as NodeJS.ProcessEnv)
    expect(c.projectCacheTtlMs).toBe(20_000)
    expect(c.flushIntervalMs).toBe(2000)
    expect(c.projectPurgeClaimDelayMs).toBe(20_000 + 2000 + CLAIM_DELAY_MARGIN_MS)
    // Strictly longer than the window it covers, never merely equal to it.
    expect(c.projectPurgeClaimDelayMs).toBeGreaterThan(c.projectCacheTtlMs + c.flushIntervalMs)
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

  it('defaults allowedOrigins to an empty array when unset', () => {
    const c = loadConfig({ ...required } as NodeJS.ProcessEnv)
    expect(c.allowedOrigins).toEqual([])
  })

  it('parses a single allowed origin', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_ALLOWED_ORIGINS: 'https://app.example.com',
    } as NodeJS.ProcessEnv)
    expect(c.allowedOrigins).toEqual(['https://app.example.com'])
  })

  it('parses several allowed origins and trims whitespace', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_ALLOWED_ORIGINS: ' https://app.example.com , https://other.example.com ',
    } as NodeJS.ProcessEnv)
    expect(c.allowedOrigins).toEqual(['https://app.example.com', 'https://other.example.com'])
  })

  it('does not produce an empty entry from a trailing comma', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_ALLOWED_ORIGINS: 'https://app.example.com,',
    } as NodeJS.ProcessEnv)
    expect(c.allowedOrigins).toEqual(['https://app.example.com'])
  })

  it('overrides the retention interval from the environment', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_RETENTION_INTERVAL_MS: '60000',
    } as NodeJS.ProcessEnv)
    expect(c.retentionIntervalMs).toBe(60_000)
  })

  // `setInterval` clamps 0 and negatives to 1ms, so either would silently
  // turn the hourly sweep into a continuous one -- a whole-database
  // list-and-drop pass with no pause between runs. Refused for the same
  // reason LYRAFLOW_RETENTION_ENABLED refuses "FALSE": a retention setting
  // read as something nobody wrote is worse than a boot that stops.
  it('rejects a retention interval of 0, which setInterval would clamp into a continuous sweep', () => {
    expect(() =>
      loadConfig({ ...required, LYRAFLOW_RETENTION_INTERVAL_MS: '0' } as NodeJS.ProcessEnv),
    ).toThrow(/LYRAFLOW_RETENTION_INTERVAL_MS must be a whole number of milliseconds >= 1/)
  })

  it('rejects a negative retention interval', () => {
    expect(() =>
      loadConfig({ ...required, LYRAFLOW_RETENTION_INTERVAL_MS: '-1000' } as NodeJS.ProcessEnv),
    ).toThrow(/LYRAFLOW_RETENTION_INTERVAL_MS must be a whole number of milliseconds >= 1/)
  })

  it('rejects a fractional retention interval', () => {
    expect(() =>
      loadConfig({ ...required, LYRAFLOW_RETENTION_INTERVAL_MS: '1500.5' } as NodeJS.ProcessEnv),
    ).toThrow(/LYRAFLOW_RETENTION_INTERVAL_MS must be a whole number of milliseconds >= 1/)
  })

  it('disables retention when the env var is "false"', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_RETENTION_ENABLED: 'false',
    } as NodeJS.ProcessEnv)
    expect(c.retentionEnabled).toBe(false)
  })

  it('keeps retention enabled when the env var is explicitly "true"', () => {
    const c = loadConfig({
      ...required,
      LYRAFLOW_RETENTION_ENABLED: 'true',
    } as NodeJS.ProcessEnv)
    expect(c.retentionEnabled).toBe(true)
  })

  it('rejects a LYRAFLOW_RETENTION_ENABLED value that is neither "true" nor "false"', () => {
    expect(() =>
      loadConfig({
        ...required,
        LYRAFLOW_RETENTION_ENABLED: 'yes',
      } as NodeJS.ProcessEnv),
    ).toThrow(/LYRAFLOW_RETENTION_ENABLED must be "true" or "false", got "yes"/)
  })
})
