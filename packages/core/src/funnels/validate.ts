import { AST_VERSION } from '../segments/ast.js'
import {
  type CostWarning,
  MAX_BEHAVIOR_NODES,
  SegmentValidationError,
  costWarnings,
  countBehaviourNodes,
  validateTree,
} from '../segments/validate.js'
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
    readonly code: 'steps' | 'window' | 'range' | 'audience',
  ) {
    super(message)
    this.name = 'FunnelValidationError'
  }
}

/**
 * Total behaviour nodes across every step audience in ONE funnel.
 *
 * Per-tree caps cannot see this. A tree may hold `MAX_BEHAVIOR_NODES` (25)
 * and a funnel `MAX_FUNNEL_STEPS` (8), so eight individually legal audiences
 * are 200 conditional aggregates in a single run.
 *
 * COVERS THE EMBEDDED AUDIENCES ONLY. `validateFunnel` is a pure function
 * over the definition and the tree behind `segment_id` lives in another
 * table; reaching it would make validation async at both call sites. That
 * tree is separately capped at `MAX_BEHAVIOR_NODES` when the segment was
 * saved, so one run's true worst case is this value PLUS
 * `MAX_BEHAVIOR_NODES` — 50 at the number below, against 200 with no cap at
 * all.
 *
 * 25 is a starting value, chosen as "one segment's worth for the whole
 * funnel" and to be confirmed by measuring a funnel at the cap against a
 * live ClickHouse. Lower it if that measurement says so. Do not raise it
 * without one.
 */
export const MAX_FUNNEL_BEHAVIOR_NODES = 25

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
  let behaviours = 0
  def.steps.forEach((step, i) => {
    if (step.audience === undefined) return
    try {
      // Through the SEGMENT validator, not a funnel-shaped copy: depth, node
      // count and per-tree behaviour count must mean the same thing in both
      // places, and the only way to guarantee that is one implementation.
      validateTree({ ast_version: AST_VERSION, filter: step.audience })
    } catch (err) {
      if (!(err instanceof SegmentValidationError)) throw err
      // Re-thrown as a funnel error NAMING THE STEP. The segment message says
      // what is wrong with the tree; without the step, an operator with eight
      // of them has to find which one by bisection.
      throw new FunnelValidationError(`step ${i + 1}: ${err.message}`, 'audience')
    }
    behaviours += countBehaviourNodes(step.audience)
  })
  if (behaviours > MAX_FUNNEL_BEHAVIOR_NODES) {
    throw new FunnelValidationError(
      `the step audiences hold ${behaviours} behavioural conditions in total; a funnel may have at most ${MAX_FUNNEL_BEHAVIOR_NODES}`,
      'audience',
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
    if (step.audience !== undefined) {
      // Prefixed with the step, NOT rewritten. `costWarnings` emits
      // `filter.children[0]`; the UI's `costWarningPath` resolves a path by
      // matching `children[N]` segments only, so the prefix is ignored there
      // by construction and the warning still lands on the right row. The
      // prefix exists so the funnel can tell two steps' warnings apart --
      // both resolve to the same editor path otherwise.
      for (const w of costWarnings({ ast_version: AST_VERSION, filter: step.audience })) {
        out.push({ path: `steps.${i}.${w.path}`, reason: w.reason })
      }
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
