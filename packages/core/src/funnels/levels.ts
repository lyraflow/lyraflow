import type { FunnelStep } from './ast.js'

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
}

export interface StepResult {
  index: number
  event: string
  people: number
  from_previous: number
  from_start: number
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
 */
export function summarise(rows: LevelRow[], steps: FunnelStep[]): FunnelResult {
  const stoppedAt = new Array<number>(steps.length + 2).fill(0)
  let partialWindowEntrants = 0

  for (const row of rows) {
    if (row.level < 1) continue
    const level = Math.min(row.level, steps.length)
    stoppedAt[level] = (stoppedAt[level] ?? 0) + row.people
    partialWindowEntrants += row.partial
  }

  // Suffix sum: reaching step N means stopping at N or anywhere beyond it.
  const atLeast = new Array<number>(steps.length + 2).fill(0)
  for (let i = steps.length; i >= 1; i--) {
    atLeast[i] = (stoppedAt[i] ?? 0) + (atLeast[i + 1] ?? 0)
  }

  const entered = atLeast[1] ?? 0
  const converted = atLeast[steps.length] ?? 0
  const rate = (n: number, d: number) => (d === 0 ? 0 : n / d)

  return {
    entered,
    converted,
    conversion_rate: rate(converted, entered),
    partial_window_entrants: partialWindowEntrants,
    steps: steps.map((step, i) => {
      const people = atLeast[i + 1] ?? 0
      // Step 1's "previous" is itself: everyone who entered reached it by
      // definition, so the rate is 1 whenever anyone entered at all.
      const previous = i === 0 ? people : (atLeast[i] ?? 0)
      return {
        index: i + 1,
        event: step.event,
        people,
        from_previous: rate(people, previous),
        from_start: rate(people, entered),
      }
    }),
  }
}
