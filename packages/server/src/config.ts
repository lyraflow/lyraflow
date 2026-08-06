import type { ChConfig } from '@lyraflow/db'

export interface Config {
  port: number
  pgUrl: string
  ch: ChConfig
  flushIntervalMs: number
  flushRows: number
  bufferMaxRows: number
  drainDeadlineMs: number
}

/**
 * Docker's stop_grace_period in the shipped compose file. The drain deadline
 * must stay below it, otherwise SIGKILL arrives mid-drain and the graceful
 * shutdown guarantee is silently void.
 */
export const STOP_GRACE_PERIOD_MS = 30_000

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${raw}"`)
  return parsed
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const required = [
    'LYRAFLOW_POSTGRES_URL',
    'LYRAFLOW_CLICKHOUSE_URL',
    'LYRAFLOW_CLICKHOUSE_USER',
    'LYRAFLOW_CLICKHOUSE_PASSWORD',
    'LYRAFLOW_CLICKHOUSE_DB',
  ]
  const missing = required.filter((k) => !env[k])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const drainDeadlineMs = num(env, 'LYRAFLOW_DRAIN_DEADLINE_MS', 25_000)
  if (drainDeadlineMs >= STOP_GRACE_PERIOD_MS) {
    throw new Error(
      `LYRAFLOW_DRAIN_DEADLINE_MS (${drainDeadlineMs}) must be below the compose ` +
        `stop_grace_period (${STOP_GRACE_PERIOD_MS}ms), or SIGKILL will interrupt the drain.`,
    )
  }

  return {
    port: num(env, 'LYRAFLOW_PORT', 3000),
    pgUrl: env.LYRAFLOW_POSTGRES_URL as string,
    ch: {
      url: env.LYRAFLOW_CLICKHOUSE_URL as string,
      username: env.LYRAFLOW_CLICKHOUSE_USER as string,
      password: env.LYRAFLOW_CLICKHOUSE_PASSWORD as string,
      database: env.LYRAFLOW_CLICKHOUSE_DB as string,
    },
    flushIntervalMs: num(env, 'LYRAFLOW_FLUSH_INTERVAL_MS', 1000),
    flushRows: num(env, 'LYRAFLOW_FLUSH_ROWS', 1000),
    bufferMaxRows: num(env, 'LYRAFLOW_BUFFER_MAX_ROWS', 100_000),
    drainDeadlineMs,
  }
}
