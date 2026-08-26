import type { FunnelStep } from './ast.js'
import { funnelSpine } from './spine.js'

/**
 * One row of `windowFunnel`'s histogram: how many people got no further than
 * this level. A person who finished step 3 appears once, at level 3 — not at
 * 1, 2 and 3.
 */
export interface LevelRow {
  level: number
  people: number
  /** Of those, how many entered too recently to have had the full window. */
  partial: number
  /**
   * Of the people in this row, how many reached each OPTIONAL step -- one
   * entry per optional step, in definition order, matching
   * `funnelSpine().optional`.
   *
   * On the row rather than as a scalar because the histogram is grouped by
   * spine level and these are `countIf`s inside that same group. Summing
   * them across rows is the step's total, which is what `summarise` does --
   * a person is in exactly one level row, so nobody is counted twice.
   *
   * Absent on a funnel with no optional steps, which is every row the
   * histogram produced before v3.
   */
  optionalReached?: number[]
}

export interface StepResult {
  index: number
  event: string
  people: number
  from_previous: number
  from_start: number
  /**
   * Present, and always `true`, only on an optional step. Absent on a
   * required one rather than `false`: a client renders the branch treatment
   * on truthiness, and `optional: false` beside `skipped: 0` on every
   * required step is two fields of noise on the common case.
   */
  optional?: true
  /**
   * Optional steps only: people who reached the required step this branches
   * off and did NOT do this one inside the window.
   *
   * Exact, not approximate. The branch chain and the spine share their
   * prefix, so both aggregates agree on the branch point's population -- see
   * `spine.ts`. Do NOT clamp this at zero: a negative value means the two
   * chains disagreed, which is a defect that must be visible rather than
   * rounded away.
   */
  skipped?: number
}

export interface FunnelResult {
  entered: number
  converted: number
  conversion_rate: number
  steps: StepResult[]
  partial_window_entrants: number
}

/**
 * Turns the level histogram into per-step counts and rates.
 *
 * This module exists on its own for one reason: step N's count is the number
 * of people at level **>= N**, and writing it as `level === N` is the
 * off-by-one this whole feature is most likely to ship. Keeping the
 * arithmetic here means it is pinned by tests that need no database, rather
 * than inferred from a live query whose numbers nobody can check by hand.
 *
 * Level 0 is dropped: `windowFunnel` returns it for a person who matched no
 * step at all, and such a person has not entered the funnel. Counting them
 * would inflate `entered` with everyone who merely had an event in the range.
 *
 * A level beyond the step count is folded into the final step rather than
 * extending the output. `windowFunnel` cannot return one, so seeing it means
 * the stored definition and the executed query disagreed — and inventing a
 * step nobody defined is a worse answer than attributing it to the last real
 * one.
 *
 * Rates are returned BOTH ways because deriving `from_start` from a chain of
 * `from_previous` floats is a multiplication every caller gets subtly wrong in
 * a different way. Zero denominators yield 0, never NaN: a rate rendered as
 * `NaN` in a report reads as a broken product rather than as an empty funnel.
 *
 * The spine is what this counts. A required step's people is the number at
 * spine rank >= its RANK, which is not its definition position once an
 * optional step sits before it -- see `spine.ts`, which is where that
 * arithmetic lives so it can be pinned without a database.
 */
export function summarise(rows: LevelRow[], steps: FunnelStep[]): FunnelResult {
  const spine = funnelSpine(steps)
  const spineLength = spine.required.length
  const stoppedAt = new Array<number>(spineLength + 2).fill(0)
  const optionalTotals = new Array<number>(spine.optional.length).fill(0)
  let partialWindowEntrants = 0

  for (const row of rows) {
    // Summed for EVERY row, including level 0: a person who matched no spine
    // step reached no branch either, so their contribution is zero and
    // skipping them would only hide a compiler that disagreed.
    for (let j = 0; j < optionalTotals.length; j++) {
      optionalTotals[j] = (optionalTotals[j] ?? 0) + (row.optionalReached?.[j] ?? 0)
    }
    if (row.level < 1) continue
    // Clamped against the SPINE's length, not the definition's: the level
    // this counts is a position in the required chain.
    const level = Math.min(row.level, spineLength)
    stoppedAt[level] = (stoppedAt[level] ?? 0) + row.people
    partialWindowEntrants += row.partial
  }

  // Suffix sum: reaching spine rank N means stopping at N or anywhere beyond it.
  const atLeast = new Array<number>(spineLength + 2).fill(0)
  for (let i = spineLength; i >= 1; i--) {
    atLeast[i] = (stoppedAt[i] ?? 0) + (atLeast[i + 1] ?? 0)
  }

  const entered = atLeast[1] ?? 0
  const converted = atLeast[spineLength] ?? 0
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d)

  return {
    entered,
    converted,
    conversion_rate: rate(converted, entered),
    partial_window_entrants: partialWindowEntrants,
    steps: steps.map((step, i) => {
      const placement = spine.placements[i]
      const base = { index: i + 1, event: step.event }

      if (placement?.branch !== undefined) {
        // An optional step is measured by its own chain and rated against
        // the required step it hangs off -- NOT against the step before it
        // in definition order, which may be another optional step.
        const people = optionalTotals[placement.branch.index] ?? 0
        const branchPoint =
          placement.spineRank === 0 ? entered : (atLeast[placement.spineRank] ?? 0)
        return {
          ...base,
          people,
          from_previous: rate(people, branchPoint),
          from_start: rate(people, entered),
          optional: true as const,
          skipped: branchPoint - people,
        }
      }

      // BY SPINE RANK, never by definition position. The two agree exactly
      // until an optional step sits before this one, which is what makes
      // getting it wrong invisible to any funnel that has none.
      const rank = placement?.spineRank ?? i + 1
      const people = atLeast[rank] ?? 0
      // Spine step 1's "previous" is itself: everyone who entered reached it
      // by definition, so the rate is 1 whenever anyone entered at all.
      const previous = rank <= 1 ? people : (atLeast[rank - 1] ?? 0)
      return {
        ...base,
        people,
        from_previous: rate(people, previous),
        from_start: rate(people, entered),
      }
    }),
  }
}
