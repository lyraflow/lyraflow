/**
 * Retention arithmetic, kept pure and free of any database so the one
 * calculation that can destroy data is testable in isolation -- and so
 * store.ts, which issues the irreversible DROP, contains no arithmetic of
 * its own to get wrong.
 *
 * Everything here is UTC and month-granular. Partitions are whole months
 * (`PARTITION BY (project_id, toYYYYMM(timestamp))`), so there is no
 * meaningful sub-month boundary to compute: a project on 13 months holds
 * between 13 and 14 months of data depending on the day. A floor, not a
 * promise of exactness.
 */

/**
 * The first month that must be KEPT. Anything strictly older is a candidate.
 *
 * `months` is assumed to be a positive integer -- the column that supplies it
 * is `CHECK (retention_months BETWEEN 1 AND 120)`, so this function does not
 * re-validate it. A negative value would silently produce a boundary in the
 * *future*, which is the direction that deletes data the policy promised to
 * keep; it is not guarded here because nothing on the path to this function
 * can currently produce one, and `assertDroppable` -- called immediately
 * before the irreversible act, on values parsed from ClickHouse rather than
 * read through that constraint -- is where input this function trusts is
 * actually re-checked.
 */
export function retentionBoundary(now: Date, months: number): Date {
  // Built from components rather than setMonth on a copy: setMonth on the
  // 31st of a month rolls forward into the next one (2026-03-31 minus one
  // month lands in March, not February). Date.UTC normalises a negative or
  // over-large month index into the right year without that hazard.
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1))
}

export function toYYYYMM(d: Date): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1)
}

/** ClickHouse partition keys, `YYYYMM` as a number, strictly older than the boundary. */
export function expiredPartitions(partitionMonths: number[], boundary: Date): number[] {
  const cutoff = toYYYYMM(boundary)
  return partitionMonths.filter((m) => m < cutoff).sort((a, b) => a - b)
}

/**
 * Guards the one irreversible act in this feature. Called immediately before
 * every `ALTER TABLE ... DROP PARTITION` -- deliberately redundant with the
 * filtering in `expiredPartitions`, because after a partition is gone the
 * only record it existed is a log line, and that log line needs to say
 * exactly what was refused and for whom.
 */
export function assertDroppable(partition: number, boundaryMonth: number, projectId: number): void {
  // `Number.isInteger` rejects NaN, +/-Infinity, and non-whole numbers in one
  // check. Both arguments arrive parsed out of `system.parts` -- a parse that
  // silently yields NaN is exactly the failure this guard exists to catch,
  // since `NaN >= boundaryMonth` is `false` and would otherwise fall through
  // and let a garbage partition value reach `ALTER TABLE ... DROP PARTITION`.
  if (!Number.isInteger(partition)) {
    throw new Error(
      `refusing to evaluate partition drop for project ${projectId}: partition ${partition} is not a finite integer`,
    )
  }
  if (!Number.isInteger(boundaryMonth)) {
    throw new Error(
      `refusing to evaluate partition drop for project ${projectId}: boundary month ${boundaryMonth} is not a finite integer`,
    )
  }
  if (partition >= boundaryMonth) {
    throw new Error(
      `refusing to drop partition ${partition} for project ${projectId}: not older than retention boundary month ${boundaryMonth}`,
    )
  }
}
