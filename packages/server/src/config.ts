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
  /** How long `ProjectCache` serves a project row it already fetched. See
   * `DEFAULT_PROJECT_CACHE_TTL_MS`. */
  projectCacheTtlMs: number
  projectPurgeIntervalMs: number
  projectPurgeLeaseMs: number
  projectPurgeMaxAttempts: number
  /** Derived, never read from its own environment variable — see
   * `purgeClaimDelayMs`. */
  projectPurgeClaimDelayMs: number
  allowedOrigins: string[]
  retentionIntervalMs: number
  retentionEnabled: boolean
  /**
   * Read once at boot by ensureAdminUser and never again. Absent on any
   * install that predates the admin account, which is why nothing here
   * throws on a missing value -- see auth/bootstrap.ts.
   */
  adminEmail: string | undefined
  adminPassword: string | undefined
}

/**
 * Docker's stop_grace_period in the shipped compose file. The drain deadline
 * must stay below it, otherwise SIGKILL arrives mid-drain and the graceful
 * shutdown guarantee is silently void.
 */
export const STOP_GRACE_PERIOD_MS = 30_000

/**
 * `ProjectCache`'s positive TTL. It was a literal at the one place the cache
 * is constructed until a second consumer appeared that has to know the same
 * number: `purgeClaimDelayMs` below.
 */
export const DEFAULT_PROJECT_CACHE_TTL_MS = 60_000

/** `IngestBuffer`'s flush cadence — how long an already-accepted event can
 * sit in memory before it lands in `events`. */
export const DEFAULT_FLUSH_INTERVAL_MS = 1_000

/**
 * Added to the cache horizon so the two windows below are covered even when
 * the clock they are measured against is not the one that stamped
 * `requested_at`: a `ProjectCache` lookup issued a moment BEFORE the
 * `deleting_at` write commits can still land after it, and caches a row that
 * is already out of date the instant it is stored. The margin is the
 * allowance for that round trip (and for a process paused mid-lookup by GC
 * or by the scheduler), not decoration on top of a number that is already
 * exact.
 */
export const CLAIM_DELAY_MARGIN_MS = 5_000

/**
 * How long a `project_deletions` row must sit before any purge may claim it.
 *
 * LOAD-BEARING, NOT POLITENESS. `purgeProject`'s verify step says "ingest is
 * already refused by then, so the reappearing set is bounded" — this delay is
 * the only thing that makes that sentence true. Ingest reads `deletingAt` off
 * `ProjectCache`, an in-process map with a TTL, so for up to
 * `projectCacheTtlMs` after the stamp ANY process can still be answering 202
 * from a cached row that says the project is live, and for a further
 * `flushIntervalMs` the events it accepted are still in `IngestBuffer` on
 * their way to `events`. `DELETE /v1/projects/:id` calls
 * `projects.invalidate()`, but that clears one process's memory: it says
 * nothing about a second app process, and nothing at all about the CLI, which
 * writes `deleting_at` straight to Postgres and can reach no cache anywhere.
 *
 * Start a purge inside that window and the teardown races events that are
 * still being accepted; the Postgres row is then deleted while ClickHouse
 * partitions are being repopulated, which is exactly the orphaned-project
 * state (#39) this whole feature exists to make unreachable — reported as a
 * success. Waiting the window out costs one delay per delete and removes the
 * race entirely.
 */
export function purgeClaimDelayMs(opts: {
  projectCacheTtlMs: number
  flushIntervalMs: number
}): number {
  return opts.projectCacheTtlMs + opts.flushIntervalMs + CLAIM_DELAY_MARGIN_MS
}

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

  // `num()` alone would accept `0` and negatives here, and `setInterval`
  // clamps both to 1ms -- a whole-database retention sweep running
  // continuously, forever, from a typo. The worker's `#inFlight` flag means
  // no two sweeps overlap, so no data is at risk, but that is the same
  // argument `LYRAFLOW_RETENTION_ENABLED` refuses `FALSE` and `0` on: a
  // retention setting read as something the operator did not write is worse
  // than a boot that stops and says so. Non-integers are refused with them,
  // since a millisecond count is not a quantity anyone means fractionally.
  const retentionIntervalMs = num(env, 'LYRAFLOW_RETENTION_INTERVAL_MS', 3_600_000)
  if (!Number.isInteger(retentionIntervalMs) || retentionIntervalMs < 1) {
    throw new Error(
      `LYRAFLOW_RETENTION_INTERVAL_MS must be a whole number of milliseconds >= 1, got "${retentionIntervalMs}"`,
    )
  }

  // Read once and used TWICE: as `ProjectCache`'s TTL, and as the cache
  // horizon a project purge must wait out before it may claim. The two are
  // the same number by construction rather than by two literals agreeing —
  // tuning the TTL down without the claim delay following it would leave the
  // delay longer than it needs to be; tuning it UP without the delay
  // following would reopen the race the delay exists to close.
  const projectCacheTtlMs = num(env, 'LYRAFLOW_PROJECT_CACHE_TTL_MS', DEFAULT_PROJECT_CACHE_TTL_MS)
  const flushIntervalMs = num(env, 'LYRAFLOW_FLUSH_INTERVAL_MS', DEFAULT_FLUSH_INTERVAL_MS)

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
    flushIntervalMs,
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
    // The project purge's own knobs, separate from the person purge's: a
    // project teardown is minutes of partition drops and mutations where a
    // person purge is seconds, so the lease that makes a crash recoverable
    // is not the same number.
    projectCacheTtlMs,
    projectPurgeIntervalMs: num(env, 'LYRAFLOW_PROJECT_PURGE_INTERVAL_MS', 15_000),
    projectPurgeLeaseMs: num(env, 'LYRAFLOW_PROJECT_PURGE_LEASE_MS', 1_800_000),
    projectPurgeMaxAttempts: num(env, 'LYRAFLOW_PROJECT_PURGE_MAX_ATTEMPTS', 5),
    // Not its own environment variable on purpose: an operator who could set
    // this independently could set it BELOW the cache TTL, and a purge
    // claimed one second early is indistinguishable from a purge that worked
    // until the day it silently did not.
    projectPurgeClaimDelayMs: purgeClaimDelayMs({ projectCacheTtlMs, flushIntervalMs }),
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
    // configured `retention_months`. Validated above: `0` and negatives are
    // refused rather than silently clamped by `setInterval` into a
    // continuous sweep.
    retentionIntervalMs,
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
    adminEmail: env.LYRAFLOW_ADMIN_EMAIL,
    adminPassword: env.LYRAFLOW_ADMIN_PASSWORD,
  }
}
