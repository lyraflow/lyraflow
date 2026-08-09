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

/** The first month that must be KEPT. Anything strictly older is a candidate. */
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
  if (partition >= boundaryMonth) {
    throw new Error(
      `refusing to drop partition ${partition} for project ${projectId}: not older than retention boundary month ${boundaryMonth}`,
    )
  }
}
