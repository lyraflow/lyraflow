import type { CostWarning } from '../segments/validate.js'
import type { FunnelDefinition } from './ast.js'

/**
 * Ceilings, not suggestions — the same reasoning as the segment executor's.
 *
 * Every one of these is reachable by an authenticated caller, and `events` is
 * ordered by (project_id, timestamp, anonymous_id, event_id): a person-level
 * report is therefore always a scan-then-group over the range, and nothing
 * about the sort key bounds it. These do.
 */
export const MAX_FUNNEL_STEPS = 8
/**
 * 30 days. Past this a funnel is a retention question, which is a different
 * report with a different output shape — answering it through this endpoint
 * would produce a number that looks like a conversion rate and is not one.
 */
export const MAX_WINDOW_SECONDS = 2_592_000
export const MAX_RANGE_DAYS = 90

const MS_PER_DAY = 86_400_000

/**
 * Events that exist in every project and dwarf everything else in it. A step
 * on one of these cannot use `idx_event` to skip granules, so the scan reads
 * far more than a step on a distinct custom event does.
 */
const HIGH_VOLUME_EVENTS = new Set(['$page', '$identify'])

export class FunnelValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'steps' | 'window' | 'range',
  ) {
    super(message)
    this.name = 'FunnelValidationError'
  }
}

/**
 * Definition-level caps, checked at CREATE time as well as at run time.
 *
 * A definition that saves with a 201 and then fails on every single run is a
 * funnel that looks fine until someone uses it — exactly the trap
 * `POST /v1/segments` already closes for filter trees, and for the same
 * reason: shape-valid is not cap-valid, and Zod only checks the first.
 */
export function validateFunnel(def: FunnelDefinition): void {
  if (def.steps.length > MAX_FUNNEL_STEPS) {
    throw new FunnelValidationError(`a funnel may have at most ${MAX_FUNNEL_STEPS} steps`, 'steps')
  }
  if (def.window_seconds > MAX_WINDOW_SECONDS) {
    throw new FunnelValidationError(
      `the conversion window may be at most ${MAX_WINDOW_SECONDS} seconds (30 days)`,
      'window',
    )
  }
}

/**
 * Run-time caps. Separate from the definition's because the range is supplied
 * per run — the same funnel is legal over a week and illegal over a year.
 */
export function validateRange(range: { since: Date; until: Date }): void {
  if (!(range.since < range.until)) {
    throw new FunnelValidationError('`since` must be strictly before `until`', 'range')
  }
  if (range.until.getTime() - range.since.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
    throw new FunnelValidationError(`the range may span at most ${MAX_RANGE_DAYS} days`, 'range')
  }
}

/**
 * Non-fatal. These funnels run; they are expensive enough that whoever asked
 * should know before reading the number. Naming the step is the point — "this
 * funnel is slow" is not actionable, "step 1 matches `$page`" is.
 */
export function funnelCostWarnings(
  def: FunnelDefinition,
  range: { since: Date; until: Date },
): CostWarning[] {
  const out: CostWarning[] = []
  def.steps.forEach((step, i) => {
    if (HIGH_VOLUME_EVENTS.has(step.event)) {
      out.push({
        path: `steps.${i}`,
        reason: `the \`${step.event}\` step matches a high-volume event, so this funnel scans far more rows than one over distinct custom events`,
      })
    }
  })
  if (range.until.getTime() - range.since.getTime() >= MAX_RANGE_DAYS * MS_PER_DAY) {
    out.push({
      path: 'range',
      reason: `the range is at the ${MAX_RANGE_DAYS}-day maximum, which is the most expensive scan this endpoint allows`,
    })
  }
  return out
}
