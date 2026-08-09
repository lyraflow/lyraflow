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
 * *future* -- e.g. `-1` from a `now` of 2026-08-09 yields `2026-09-01`, a
 * perfectly well-formed `202609`. That is the direction that deletes data
 * the policy promised to keep: every existing partition, including the
 * current month, would then compare as older than that boundary. Note that
 * `assertDroppable` does *not* catch this -- it checks that a partition and
 * a boundary are well-formed and correctly ordered relative to each other,
 * not that the boundary was derived correctly in the first place, and a
 * future boundary is exactly as internally consistent as a correct one.
 * What actually catches this failure mode is Task 2's "never drop every
 * partition a project has" guard, which looks at the shape of the result
 * rather than any one pair.
 *
 * This function deliberately does not throw on a negative `months` itself:
 * there is no reachable caller today -- the CHECK constraint is the only
 * write path to this value -- and the shape guard covers the catastrophic
 * outcome if that were ever wrong. That stops being true the moment any
 * caller passes a `months` that did not come through the column -- an admin
 * preview, a CLI override -- which must validate before calling this
 * function, or this guard needs to move here.
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

// A generous but bounded YYYYMM window. The retention column tops out at 120
// months (10 years), so every value this system will ever legitimately
// compute sits close to the present -- this range is far wider than that on
// purpose, so it never needs revisiting for the foreseeable life of the
// product, while still firmly excluding the values a bad parse or a flipped
// sign actually produce: negative numbers, zero, and other integers nowhere
// near a real calendar month. It is not full YYYYMM validation (it does not
// check the month component is 01-12); that finer check belongs with the
// ClickHouse layer that produces these numbers, not with the guard in front
// of the irreversible act.
const MIN_PLAUSIBLE_YYYYMM = 200_001 // January 2000
const MAX_PLAUSIBLE_YYYYMM = 210_012 // December 2100

/**
 * Guards the one irreversible act in this feature. Called immediately before
 * every `ALTER TABLE ... DROP PARTITION` -- deliberately redundant with the
 * filtering in `expiredPartitions`, because after a partition is gone the
 * only record it existed is a log line, and that log line needs to say
 * exactly what was refused and for whom.
 *
 * Validates that `partition` and `boundaryMonth` are individually well-formed
 * and correctly ordered. It cannot detect a boundary that was *derived*
 * incorrectly (see `retentionBoundary`'s docstring for that failure mode and
 * what actually catches it).
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
  // Integer alone still admits -1, 0, and other values no real partition or
  // boundary could ever be -- the same class of "parse went wrong" input the
  // integer check above targets, just landing on a plausible-looking number
  // instead of an obviously broken one.
  if (partition < MIN_PLAUSIBLE_YYYYMM || partition > MAX_PLAUSIBLE_YYYYMM) {
    throw new Error(
      `refusing to evaluate partition drop for project ${projectId}: partition ${partition} is not a plausible YYYYMM value`,
    )
  }
  if (boundaryMonth < MIN_PLAUSIBLE_YYYYMM || boundaryMonth > MAX_PLAUSIBLE_YYYYMM) {
    throw new Error(
      `refusing to evaluate partition drop for project ${projectId}: boundary month ${boundaryMonth} is not a plausible YYYYMM value`,
    )
  }
  if (partition >= boundaryMonth) {
    throw new Error(
      `refusing to drop partition ${partition} for project ${projectId}: not older than retention boundary month ${boundaryMonth}`,
    )
  }
}
