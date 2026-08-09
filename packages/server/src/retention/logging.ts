import type { DropResult, RetentionTarget } from './store.js'

/** The narrowest shape this module needs from a logger — not `FastifyBaseLogger` itself, so a test can pass a bare spy. */
export interface DropLogger {
  info(fields: Record<string, unknown>, msg: string): void
}

/**
 * Wraps a `RetentionStore#dropExpired`-shaped function so every partition
 * ACTUALLY dropped (`r.dropped === true`) is logged once, at `info`, naming
 * project, table and partition. This is Guard 5 (see app.ts's own docstring
 * on why): `RetentionStore#dropExpired` returns every partition it touched
 * but writes nothing down itself, and once a partition is gone this log
 * line is the only record it ever existed.
 *
 * Pulled out of app.ts into its own function specifically so the
 * `if (r.dropped)` check can be unit-tested against a MIX of `dropped: true`
 * and `dropped: false` results (see logging.test.ts). app.ts's production
 * wiring hardcodes `RetentionStore`'s own `dryRun: false`, so nothing
 * exercises the `dropped: false` branch through a real call in that file —
 * a `dropped: false` result only comes from a genuine dry run (see
 * store.ts's `dropOnePartition`), and app.ts's store never runs one. A test
 * that only ever sees `dropped: true` results cannot tell `if (r.dropped)`
 * apart from `if (true)` — both stay green — so this needs a fabricated
 * mixed result set to prove the check does anything at all.
 */
export function wrapWithDropLogging(
  dropExpired: (target: RetentionTarget, now: Date) => Promise<DropResult[]>,
  log: DropLogger,
): (target: RetentionTarget, now: Date) => Promise<DropResult[]> {
  return async (target, now) => {
    const results = await dropExpired(target, now)
    for (const r of results) {
      if (r.dropped) {
        log.info(
          { projectId: r.projectId, table: r.table, partition: r.partition },
          'retention dropped partition',
        )
      }
    }
    return results
  }
}
