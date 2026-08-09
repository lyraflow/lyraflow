import type { ChConfig } from '@lyraflow/db'

export interface Config {
  port: number
  pgUrl: string
  ch: ChConfig
  flushIntervalMs: number
  flushRows: number
  bufferMaxRows: number
  drainDeadlineMs: number
  purgeIntervalMs: number
  purgeLeaseMs: number
  purgeMaxAttempts: number
  allowedOrigins: string[]
  retentionIntervalMs: number
  retentionEnabled: boolean
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

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${key} must be "true" or "false", got "${raw}"`)
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
    // How often the purge worker looks for a claimable request. Frequent is
    // cheap: the claim is one indexed statement that returns nothing when
    // there is no work.
    purgeIntervalMs: num(env, 'LYRAFLOW_PURGE_INTERVAL_MS', 15_000),
    // How long a claim is held before another worker may take the request
    // over. Must comfortably exceed the longest plausible purge — a
    // ClickHouse mutation over a large partition takes minutes — or two
    // workers would run the same purge concurrently. Concurrent runs are
    // safe (every step is a predicated delete) but wasteful.
    purgeLeaseMs: num(env, 'LYRAFLOW_PURGE_LEASE_MS', 600_000),
    // A poisoned request stops being claimed past this, with last_error
    // saying why, rather than spinning forever.
    purgeMaxAttempts: num(env, 'LYRAFLOW_PURGE_MAX_ATTEMPTS', 5),
    // Origins permitted to call the write-key ingest routes from a browser.
    // Empty means any origin.
    //
    // This is NOT a security boundary. The write key is public by design — it
    // ships in page source — and any non-browser client ignores CORS entirely.
    // What an allowlist buys is stopping someone pasting your key on their own
    // site and polluting your data: a product limit made tamper-evident, the same
    // category as the segment cursor's signature. Do not lean on it for anything
    // else.
    //
    // Defaulting to deny would mean a fresh install's snippet fails silently on
    // first paste, which is a worse failure than the one it prevents.
    allowedOrigins: (env.LYRAFLOW_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    // How often the retention worker looks for expired partitions to drop.
    // The work is dropping a whole ClickHouse partition, a metadata
    // operation, not a per-row scan or mutation — and retention is measured
    // in months, so a missed hour costs nothing. Hourly is frequent enough
    // that a project's actual retention never drifts meaningfully past its
    // configured `retention_months`.
    retentionIntervalMs: num(env, 'LYRAFLOW_RETENTION_INTERVAL_MS', 3_600_000),
    // Off is a legitimate choice for an operator managing retention some
    // other way (their own job, their own tooling) — silently doing nothing
    // is not. Disabling this logs once at startup (see index.ts) so the
    // choice is visible rather than merely absent.
    //
    // Only the lowercase literals "true"/"false" are accepted — see bool()
    // above. `LYRAFLOW_RETENTION_ENABLED=FALSE` or `=0` is refused with a
    // thrown error before any logger exists, not silently coerced to `true`:
    // silently accepting an unrecognised "off" spelling would keep deleting
    // data an operator believed they had turned off, which is the worse
    // failure of the two by a wide margin.
    retentionEnabled: bool(env, 'LYRAFLOW_RETENTION_ENABLED', true),
  }
}
