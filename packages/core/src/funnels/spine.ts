import type { FunnelStep } from './ast.js'

/**
 * Where one definition step sits relative to the required chain.
 */
export interface StepPlacement {
  /** 0-based position in `definition.steps`. */
  position: number
  optional: boolean
  /**
   * A REQUIRED step: its own 1-based rank in the spine.
   * An OPTIONAL step: the rank of the last required step BEFORE it -- the
   * step it branches off, and the denominator of its `from_previous`.
   *
   * 0 for an optional step with no required step before it. `validateFunnel`
   * makes that unreachable; this module still defines it, because a pure
   * function that throws its caller's validation rule is that rule stated
   * twice.
   */
  spineRank: number
  /** Optional steps only: which branch chain measures this step, and the
   * level that chain must reach for the step to count. */
  branch?: { index: number; level: number }
}

export interface FunnelSpine {
  /** 0-based positions of the required steps, in order. The spine chain is
   * their conditions, in this order. */
  required: number[]
  /** 0-based positions of the optional steps, in order. One branch chain
   * each, numbered by this array's index. */
  optional: number[]
  /** One entry per definition step, in definition order. */
  placements: StepPlacement[]
}

/**
 * Splits a step list into the required spine and the optional branches.
 *
 * This module exists on its own for one reason: a required step's count is
 * the number of people at spine rank >= its RANK, and writing that as its
 * definition POSITION is the off-by-one this feature is most likely to
 * ship. The two agree exactly until an optional step sits before it, so a
 * test over a funnel with no optional steps cannot catch it and the
 * arithmetic has to be pinned here, where it needs no database.
 *
 * A branch chain for the optional step at position `k` is the required
 * steps before `k`, in order, followed by `k` itself -- so it reaches
 * `level = spineRank + 1` exactly when the person did all of them and then
 * did `k`, inside one window. `branch.level` is that number.
 *
 * The branch and the spine SHARE THEIR PREFIX, which is what makes
 * `skipped` exact rather than approximate: `level >= spineRank` asks about
 * conditions both chains hold verbatim, so the two aggregates cannot
 * disagree about the population at the step being branched off.
 */
export function funnelSpine(steps: readonly FunnelStep[]): FunnelSpine {
  const required: number[] = []
  const optional: number[] = []
  const placements: StepPlacement[] = []

  for (const [position, step] of steps.entries()) {
    const isOptional = step.optional === true
    if (isOptional) {
      // Read BEFORE pushing, so an optional step's rank is the number of
      // required steps that precede it and never counts itself.
      const spineRank = required.length
      placements.push({
        position,
        optional: true,
        spineRank,
        branch: { index: optional.length, level: spineRank + 1 },
      })
      optional.push(position)
      continue
    }
    required.push(position)
    placements.push({ position, optional: false, spineRank: required.length })
  }

  return { required, optional, placements }
}
