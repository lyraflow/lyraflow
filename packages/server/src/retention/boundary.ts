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
 * `months` is assumed to be a positive integer, and this function does not
 * re-validate it. A negative value would silently produce a boundary in the
 * *future* -- e.g. `-1` from a `now` of 2026-08-09 yields `2026-09-01`, a
 * perfectly well-formed `202609`. That is the direction that deletes data
 * the policy promised to keep: every existing partition, including the
 * current month, would then compare as older than that boundary. Nothing
 * downstream of here can catch it: `assertDroppable` checks that a partition
 * and a boundary are well-formed and correctly ordered relative to each
 * other, not that the boundary was derived correctly in the first place, and
 * a future boundary is exactly as internally consistent as a correct one.
 *
 * What keeps a negative `months` out is UPSTREAM, in
 * `RetentionStore#dropExpired` (store.ts), and it is the only thing that
 * does. Before it computes a boundary, that method refuses any
 * `retentionMonths` that is not an integer in `[1, 120]` -- for every value
 * it accepts, this function subtracts at least one whole month, so a
 * boundary later than `now` is impossible by construction -- and it refuses
 * a `now` more than `MAX_CLOCK_SKEW_MS` from the real process clock, which
 * is the other input that can move this boundary and the one no comparison
 * against the boundary itself could ever detect.
 *
 * There is NO "never drop every partition a project has" shape guard
 * anywhere in this feature. One existed briefly, was replaced by a
 * future-boundary assertion, and that in turn was removed in favour of the
 * clock-skew check (see this file's and store.ts's history). A comment
 * claiming a safety net that does not exist is worse than no comment at
 * all: it invites the next author to weaken the check that does exist, on
 * the belief that something else is still watching.
 *
 * So the validation lives with the caller that issues the irreversible act,
 * and today there is exactly one. Any NEW caller that reaches this function
 * without going through `dropExpired` -- an admin preview, a CLI override --
 * must repeat that validation itself, or move it in here.
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
 *
 * THROWING HERE COSTS MORE THAN THE ONE PARTITION, and that is worth knowing
 * before reading a log line from it. `dropExpired` walks `RETENTION_TABLES`
 * in order and `expiredPartitions` returns each table's candidates
 * oldest-first, so a single out-of-range partition month stops everything
 * after it: the rest of that table, and -- since `events` is walked before
 * `device_index` -- the whole of `device_index` too. That project's
 * retention is then stuck, on this run and on every run after, because the
 * same partition is listed again every time; the only exit is removing it by
 * hand. Refusing is still the right call (the alternative is issuing an
 * irreversible drop on a value nothing here understands), but the blast
 * radius is a project's entire retention rather than one partition. Not
 * reachable through ingest -- `clampTimestamp` pins an event's timestamp to
 * within a day of receipt, so no ingested event can land outside the window
 * below -- only a direct backfill into ClickHouse can produce one.
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
