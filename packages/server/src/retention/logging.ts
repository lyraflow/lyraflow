import type { DropResult } from './store.js'

/** The narrowest shape this module needs from a logger — not `FastifyBaseLogger` itself, so a test can pass a bare spy. */
export interface DropLogger {
  info(fields: Record<string, unknown>, msg: string): void
}

/**
 * Guard 5's actual log line — see app.ts's own docstring for why it exists.
 * Meant to be passed as `RetentionStoreOptions.onDrop`, so it runs once per
 * partition, synchronously, in the same tick the `ALTER TABLE ... DROP
 * PARTITION` that dropped it returns. That call site — NOT a wrapper around
 * `RetentionStore#dropExpired`'s returned array — is what this function is
 * built for: a wrapper reading the array after `dropExpired` resolves can
 * only log once an entire project's sweep across both `RETENTION_TABLES`
 * tables has finished, which bunches every partition that project dropped
 * into one moment and loses all of them at once if the process is
 * interrupted anywhere in between. `onDrop` fires the instant each
 * partition is actually gone, so there is nothing left to bunch.
 *
 * Never behind a debug level, and never collapsed into a count — see this
 * function's own callers for why (once a partition is gone, this is the
 * only record it ever existed, and a count cannot answer "was a specific
 * one dropped").
 *
 * Guards `result.dropped` itself, even though `RetentionStore` today only
 * ever invokes `onDrop` for a genuine drop (never a dry run's `dropped:
 * false`) — defensive against a future caller of this exported function
 * that is not that store, and independently proven in logging.test.ts with
 * a fabricated `dropped: false` result, since nothing in this codebase's
 * production wiring can produce one through the real call path (`app.ts`
 * hardcodes `dryRun: false`).
 */
export function logDroppedPartition(log: DropLogger, result: DropResult): void {
  if (!result.dropped) return
  log.info(
    { projectId: result.projectId, table: result.table, partition: result.partition },
    'retention dropped partition',
  )
}
