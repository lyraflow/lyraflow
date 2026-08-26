import { AST_VERSION } from '../segments/ast.js'
import {
  type CostWarning,
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
 * Optional steps per funnel.
 *
 * Each one costs TWO extra `windowFunnel`s over rows the scan already reads
 * -- a branch chain and a full chain (see `compile.ts`) -- and both chains
 * COPY the SQL text of every required condition before them, audience
 * subqueries included. That is aggregate work, not another scan, but it is
 * not free text, and it can make the compiled query too large for
 * ClickHouse to even parse. `compileFunnel` now guards that directly --
 * see the `FunnelValidationError` it throws when the assembled SQL crosses
 * `MAX_COMPILED_QUERY_BYTES`, below -- because THIS CONSTANT DOES NOT.
 *
 * 2 is chosen because it measured strictly better than 3 on one shape, not
 * because 2 is proven safe. That shape: 8 steps (`MAX_FUNNEL_STEPS`), ONE
 * `where` predicate per step, audiences spread across all 8 steps to
 * exactly `MAX_FUNNEL_BEHAVIOR_NODES` (25) behavioural nodes, optional
 * steps at early-to-mid positions. Compiled size: 75,627 bytes at 0
 * optional, 156,762 at 1, 189,567 at 2, 270,733 at 3 -- ClickHouse's
 * default `max_query_size` is 262,144 bytes, so 3 optional steps fails
 * outright (SYNTAX_ERROR, "Max query size exceeded") and 2 does not, on
 * THAT shape only.
 *
 * What was not varied, and is NOT covered by those numbers: predicate
 * count per step (`MAX_WHERE_PREDICATES` allows up to 10, not the 1 used
 * above); trait-only audiences, which cost ZERO against
 * `MAX_FUNNEL_BEHAVIOR_NODES` while still compiling a full
 * `compileSegment` subquery (see that constant's own comment); a filter
 * tree's own node cap, `MAX_TREE_NODES` (100), which applies PER STEP,
 * independent of the funnel-wide behavioural cap; and optional-step
 * position, which changes how many required conditions each branch/full
 * chain must re-embed -- later positions duplicate more.
 *
 * Varying those found the ceiling crossed at just ONE optional step: 8
 * steps with optional steps placed later in the chain measured 270,105
 * bytes (fails); 10 `where` predicates per step plus trait-audience
 * padding, with only ONE optional step, measured 285,229 bytes (fails);
 * the identical shape at ZERO optional measured 113,290 bytes (parses). So
 * the optional-step count is not the lever that keeps this under the
 * ceiling -- query text grows with chains × prefix length × per-condition
 * size, and the last factor is unbounded by anything this module caps.
 * `MAX_COMPILED_QUERY_BYTES` is the real guard; this constant is left at 2
 * because it is still strictly better than 3, not because it closes the
 * failure mode. Lower it, or replace it with a different lever entirely,
 * if a later measurement says so. Do not raise it without one.
 */
export const MAX_OPTIONAL_STEPS = 2
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
 * That covers behavioural conditions. A trait-only audience costs zero
 * against this cap while still adding its own `compileSegment` subquery, so
 * the other dimension is audience SUBQUERIES, bounded instead by
 * `MAX_FUNNEL_STEPS` (8) — one audience per step, at most.
 *
 * 25 is a starting value, chosen as "one segment's worth for the whole
 * funnel" and to be confirmed by measuring a funnel at the cap against a
 * live ClickHouse. Lower it if that measurement says so. Do not raise it
 * without one.
 */
export const MAX_FUNNEL_BEHAVIOR_NODES = 25

/**
 * ClickHouse's default `max_query_size` is 262,144 bytes -- past this it
 * refuses to even PARSE the query (SYNTAX_ERROR, code 62, "Max query size
 * exceeded") rather than running slow. `compileFunnel` measures the
 * assembled SQL against this after building it and throws here instead,
 * because none of the per-definition caps above bound it: `MAX_FUNNEL_STEPS`,
 * `MAX_WHERE_PREDICATES` and `MAX_FUNNEL_BEHAVIOR_NODES` each bound ONE
 * dimension, but the compiled size is chains × prefix length × per-condition
 * size, and a trait-only audience costs zero against the behavioural cap
 * while still compiling a full `compileSegment` subquery (see that
 * constant's own comment) -- so a legal definition under every existing cap
 * can still fail to parse. `MAX_OPTIONAL_STEPS`'s own comment has the
 * measurements that found this.
 *
 * 230,000 stays 32,144 bytes (~12%) under ClickHouse's default -- enough
 * that a self-hosted deployment with a slightly lower `max_query_size`, or
 * a future edit that adds a little wrapping SQL, still clears the real
 * ceiling with the same margin this number was chosen against. It is well
 * above every KNOWN-GOOD shape measured so far (189,567 bytes at most), so
 * it should not refuse an ordinary funnel -- pinned in `compile.test.ts`,
 * alongside the test that pins the throw itself.
 */
export const MAX_COMPILED_QUERY_BYTES = 230_000

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
  // The first step defines ENTRY -- it is what carries the `timestamp <
  // until` bound into every chain -- and the last defines CONVERSION.
  // Optional leaves both undefined.
  //
  // "at least two required steps" is deliberately NOT checked here.
  // `steps.min(2)` and these two rules already force it, so the check could
  // never fire and its test could never fail.
  if (def.steps[0]?.optional === true) {
    throw new FunnelValidationError('the first step of a funnel cannot be optional', 'steps')
  }
  if (def.steps[def.steps.length - 1]?.optional === true) {
    throw new FunnelValidationError('the last step of a funnel cannot be optional', 'steps')
  }
  const optionalCount = def.steps.filter((s) => s.optional === true).length
  if (optionalCount > MAX_OPTIONAL_STEPS) {
    throw new FunnelValidationError(
      `a funnel may have at most ${MAX_OPTIONAL_STEPS} optional steps; this one has ${optionalCount}`,
      'steps',
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
