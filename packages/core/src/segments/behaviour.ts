import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import { notSuppressedExpr } from '../privacy/suppression.js'
import type { Behavior, Window } from './ast.js'
import { type Params, chDateTime } from './params.js'
import { wherePredicate } from './predicates.js'

export interface BehaviourPass {
  /** null when the tree has no behavioural nodes — the caller omits the join. */
  cte: string | null
  aliasFor: Map<Behavior, string>
}

/**
 * The earliest instant a window needs, or null for `ever` — which means "no
 * lower bound", not "a very old one".
 */
function windowStart(w: Window, now: Date): Date | null {
  if (w.kind === 'ever') return null
  if (w.kind === 'absolute') return new Date(w.from)
  const ms = w.unit === 'hours' ? w.n * 3_600_000 : w.n * 86_400_000
  return new Date(now.getTime() - ms)
}

/** The per-event condition for one behaviour: name, window, and `where` predicates. */
function condition(b: Behavior, params: Params, now: Date): string {
  const parts: string[] = []

  // '*' means any event, so no event_name predicate at all — a predicate of
  // `event_name = '*'` would match nothing.
  if (b.event !== '*') {
    parts.push(`event_name = ${params.add(b.event, 'String')}`)
  }

  // Re-applied per node even though the scan is already bounded by the widest
  // window in the tree: without this a 7-day condition sharing a query with a
  // 90-day one would count events from 90 days ago.
  const from = windowStart(b.window, now)
  if (from) parts.push(`timestamp >= ${params.add(chDateTime(from), 'DateTime64(3)')}`)
  if (b.window.kind === 'absolute') {
    parts.push(`timestamp <= ${params.add(chDateTime(new Date(b.window.to)), 'DateTime64(3)')}`)
  }

  for (const w of b.where ?? []) parts.push(wherePredicate(w, params))

  // A behaviour with no conditions at all (event '*', window 'ever', no
  // predicates) is legal and means "any event ever".
  return parts.length > 0 ? parts.join(' AND ') : '1'
}

/**
 * The aggregate expression for one behaviour.
 *
 * `count` is a plain countIf and NOT uniqExactIf(event_id, …): the enclosing
 * query has already deduplicated by event_id (see behaviourCte), so every row
 * reaching here is a distinct event. Deduplicating twice would be harmless but
 * misleading — it would suggest the guarantee lives here, when it lives in one
 * place for every aggregate.
 */
function aggregate(b: Behavior, cond: string, params: Params): string {
  if (b.aggregate === 'count') return `countIf(${cond})`

  const key = params.add(b.property as string, 'String')
  const numericBag = `properties_num[${key}]`
  switch (b.aggregate) {
    case 'sum':
      return `sumIf(${numericBag}, ${cond})`
    case 'min':
      return `minIf(${numericBag}, ${cond})`
    case 'max':
      return `maxIf(${numericBag}, ${cond})`
    case 'distinct':
      return `uniqExactIf(properties[${key}], ${cond})`
  }
}

/**
 * One pass over `events` for the whole tree.
 *
 * The spec's rule, and the reason this module exists: collapse every
 * behavioural node into a single scan with conditional aggregation rather
 * than emitting one subquery per node. The identity expression appears
 * exactly once, in the SELECT, and every aggregate rides the same GROUP BY.
 *
 * The scan is bounded by the WIDEST window in the entire tree — narrower
 * nodes re-apply their own bound inside their countIf — so a tree of ten
 * behaviours still reads the event range once.
 *
 * DEDUPLICATION. `LIMIT 1 BY project_id, event_id` is the enforcement point
 * for the plan's `event_id` constraint. `events` is ReplacingMergeTree
 * ordered by (project_id, timestamp, anonymous_id, event_id), and a retried
 * delivery that omitted `timestamp` arrives with a fresh server receipt time,
 * a different sort key, and is stored as a permanent second row. Doing this
 * once here makes count, sum, min, max and distinct all correct; doing it per
 * aggregate would make correctness depend on remembering, and the aggregate
 * added next year would be the one that forgot.
 */
export function behaviourCte(opts: {
  database: string
  projectId: number
  behaviors: Behavior[]
  params: Params
  now: Date
}): BehaviourPass {
  const { database, projectId, behaviors, params, now } = opts
  const aliasFor = new Map<Behavior, string>()
  if (behaviors.length === 0) return { cte: null, aliasFor }

  const projectParam = params.add(projectId, 'UInt32')

  // `ever` anywhere in the tree removes the lower bound for the whole scan:
  // one node needing all history means all history is read, and pretending
  // otherwise would silently give that node a truncated answer.
  const starts = behaviors.map((b) => windowStart(b.window, now))
  const widest = starts.includes(null)
    ? null
    : new Date(Math.min(...starts.map((d) => (d as Date).getTime())))

  const scanBound = widest
    ? ` AND timestamp >= ${params.add(chDateTime(widest), 'DateTime64(3)')}`
    : ''

  const aggregates = behaviors
    .map((b, i) => {
      const alias = `b${i}`
      aliasFor.set(b, alias)
      return `${aggregate(b, condition(b, params, now), params)} AS ${alias}`
    })
    .join(',\n      ')

  const resolved = resolvedPersonExpr({ database, alias: 'e' })

  // Per-event suppression, applied between the deduplicated scan and the
  // GROUP BY. It cannot go inside the inner subquery: `resolved` reads the
  // identity dictionaries against `e`'s own columns and only exists once the
  // subquery is aliased. It must not go inside each countIf either — that
  // would put a privacy rule in one clause per behavioural node, kept in
  // agreement by discipline, which is exactly the shape the spec forbids.
  //
  // `resolved` is therefore evaluated THREE times per row: once here in the
  // SELECT, and twice more inside notSuppressedExpr, which substitutes this
  // same `person` expression into both the `dictHas` guard and the
  // `dictGetOrDefault` lookup (suppression.ts) — see behaviour.test.ts, which
  // pins the count at three. ClickHouse folds the identical subexpression;
  // the alternative — a third nesting level to compute it once — costs more
  // in readability than it saves.
  const notSuppressed = notSuppressedExpr({
    database,
    projectId,
    params,
    person: resolved,
    instant: 'e.timestamp',
  })

  return {
    cte: `beh AS (
    SELECT
      ${resolved} AS ${RESOLVED_PERSON_ALIAS},
      ${aggregates}
    FROM (
      SELECT project_id, anonymous_id, user_id, timestamp, event_name,
             properties, properties_num, event_id
      FROM events
      WHERE project_id = ${projectParam}${scanBound}
      LIMIT 1 BY project_id, event_id
    ) AS e
    WHERE ${notSuppressed}
    GROUP BY ${RESOLVED_PERSON_ALIAS}
  )`,
    aliasFor,
  }
}
