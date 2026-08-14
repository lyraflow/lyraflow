import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import { notSuppressedExpr } from '../privacy/suppression.js'
import type { CompiledQuery } from '../segments/compile.js'
import { Params, chDateTime } from '../segments/params.js'
import { wherePredicate } from '../segments/predicates.js'
import type { FunnelDefinition, FunnelStep } from './ast.js'
import { funnelCostWarnings, validateFunnel, validateRange } from './validate.js'

/**
 * One step's condition: the event name, ANDed with any predicates on that
 * event's own properties. Every value is bound; nothing is concatenated.
 */
function stepCondition(
  step: FunnelStep,
  params: Params,
  eventPlaceholder: (event: string) => string,
): string {
  const parts = [`event_name = ${eventPlaceholder(step.event)}`]
  for (const w of step.where ?? []) parts.push(wherePredicate(w, params))
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' AND ')})`
}

/**
 * Compiles a funnel definition into ONE pass over `events`.
 *
 * The shape, and why each layer is where it is:
 *
 *   inner scan  — bounded by project, range and the funnel's own event names,
 *                 deduplicated by event_id. `event_name IN (…)` is what keeps
 *                 this affordable: `events` is ordered by (project_id,
 *                 timestamp, anonymous_id, event_id), so a person-level report
 *                 is always scan-then-group, and `idx_event` is the only index
 *                 that can skip granules.
 *   per person  — windowFunnel over the step conditions, plus the instant the
 *                 person entered. Suppression is applied here, per event, the
 *                 same way the behavioural pass does it.
 *   histogram   — people by the level they reached, and how many of them
 *                 entered too recently to have had the full window.
 *
 * `windowFunnel` SLIDES its window across candidate starts and reports the
 * longest chain it finds, which is exactly the "best attempt" rule the design
 * asks for: someone who abandoned on Monday and completed on Tuesday counts
 * as converted rather than being pinned to their first attempt.
 *
 * DEDUPLICATION is `LIMIT 1 BY project_id, event_id`, the same idiom as
 * `behaviourCte` — not `FINAL`, which appears nowhere in this product. Strictly
 * speaking a duplicate delivery cannot change which level a person reached, so
 * here it is defence in depth; it stays because a reader who finds one scan
 * deduplicating and another not will conclude the guarantee is conditional.
 *
 * `params` is accepted rather than always created so that a caller restricting
 * the funnel to a segment can compile BOTH with one instance. Names are
 * positional (`p0`, `p1`, …), so two independently-numbered maps merged after
 * the fact would silently overwrite each other — threading one instance makes
 * that impossible rather than merely unlikely.
 */
export function compileFunnel(opts: {
  definition: FunnelDefinition
  projectId: number
  database: string
  range: { since: Date; until: Date }
  /** The person-set SQL a segment restriction compiled to, if any. */
  segmentPersonSql?: string
  /** Continue an existing parameter sequence. See the note above. */
  params?: Params
  /** Injected rather than read here, so a test can pin the partial boundary. */
  now: Date
}): CompiledQuery {
  const { definition, projectId, database, range, segmentPersonSql, now } = opts

  // Thrown here rather than at ClickHouse: an over-cap funnel must fail with
  // a message naming the cap, not with a query timeout ten seconds later.
  validateFunnel(definition)
  validateRange(range)

  const params = opts.params ?? new Params()
  const projectParam = params.add(projectId, 'UInt32')

  // One placeholder per DISTINCT event name, shared between the scan's IN
  // list and every step condition that names it. Four `$page` steps therefore
  // bind `$page` once and the IN list holds one entry — binding it per step
  // would work identically and leave a reader wondering whether the
  // repetition meant the two places could disagree.
  const eventParams = new Map<string, string>()
  const eventPlaceholder = (event: string): string => {
    const existing = eventParams.get(event)
    if (existing !== undefined) return existing
    const placeholder = params.add(event, 'String')
    eventParams.set(event, placeholder)
    return placeholder
  }

  // THE RANGE BOUNDS ENTRY, NOT OBSERVATION.
  //
  // A person enters the funnel by matching step 1 inside [since, until). Their
  // conversion may land after `until` — someone who signs up an hour before
  // the range ends still has the rest of their window to finish — so the scan
  // runs on to `until + window`, capped at `now` because there are no events
  // from the future.
  //
  // The first version bounded the scan at `until` and called every entrant
  // inside one window's reach of it "partial". Run against real rows that
  // reported 100% partial for any range shorter than its own window, which is
  // the common case and made the caveat meaningless. Only genuinely recent
  // entrants — those inside one window of NOW — have an unfinished window.
  const windowMs = definition.window_seconds * 1000
  const observeUntil = new Date(Math.min(range.until.getTime() + windowMs, now.getTime()))

  const since = params.add(chDateTime(range.since), 'DateTime64(3)')
  const until = params.add(chDateTime(range.until), 'DateTime64(3)')
  const scanEnd = params.add(chDateTime(observeUntil), 'DateTime64(3)')

  // Built once and reused: windowFunnel needs every condition, and the
  // entry-instant aggregate needs the first one. Calling the builder twice for
  // one step would bind its values twice — harmless, but it would suggest the
  // two copies could legitimately differ.
  const conditions = definition.steps.map((s, i) => {
    const cond = stepCondition(s, params, eventPlaceholder)
    // Step 1 additionally bounds ENTRY to the range. Without it the extended
    // scan above would let someone whose first step lands after `until` enter
    // a funnel the caller did not ask about.
    return i === 0 ? `(${cond} AND timestamp < ${until})` : cond
  })
  // Built after the conditions, which is what populates `eventParams`.
  const eventList = [...eventParams.values()].join(', ')
  // MILLISECONDS, not seconds, and not the DateTime64 column itself.
  //
  // `windowFunnel`'s first argument must be a Date, DateTime or an unsigned
  // integer — a DateTime64(3) is rejected outright (Code 43, measured against
  // ClickHouse 24.8, not assumed). `toDateTime(timestamp)` would satisfy it by
  // truncating to whole seconds, which is the wrong repair: two steps landing
  // in the same second would compare equal and their order would stop being
  // defined, and a signup flow puts several steps inside one second routinely.
  // `toUnixTimestamp64Milli` keeps the full stored precision, so the window is
  // expressed in the same unit. `toUInt64` around it is required rather than
  // decorative: that function returns a SIGNED Int64, which the aggregate
  // rejects with the same Code 43 the DateTime64 did.
  //
  // 30 days in milliseconds is 2_592_000_000, comfortably inside UInt32's
  // 4_294_967_295 — the cap in validate.ts is what keeps that true, so the two
  // must move together.
  const windowParam = params.add(definition.window_seconds * 1000, 'UInt32')

  // Anyone whose entry lands after this has not had a full window of REAL
  // TIME yet, whatever the range says. They are counted in `entered` —
  // dropping them would make a recent funnel report a population it did not
  // have — and reported separately so the rate can be read for what it is.
  const partialBoundary = params.add(
    chDateTime(new Date(now.getTime() - windowMs)),
    'DateTime64(3)',
  )

  const resolved = resolvedPersonExpr({ database, alias: 'e' })
  const notSuppressed = notSuppressedExpr({
    database,
    projectId,
    params,
    person: resolved,
    instant: 'e.timestamp',
  })

  const segmentFilter = segmentPersonSql
    ? `\n  AND ${RESOLVED_PERSON_ALIAS} IN (${segmentPersonSql})`
    : ''

  const sql = `SELECT
  level,
  count() AS people,
  countIf(entered_at > ${partialBoundary}) AS partial
FROM (
  SELECT
    ${resolved} AS ${RESOLVED_PERSON_ALIAS},
    windowFunnel(${windowParam})(toUInt64(toUnixTimestamp64Milli(timestamp)), ${conditions.join(', ')}) AS level,
    minIf(timestamp, ${conditions[0]}) AS entered_at
  FROM (
    SELECT project_id, anonymous_id, user_id, timestamp, event_name,
           properties, properties_num, event_id
    FROM events
    WHERE project_id = ${projectParam}
      AND timestamp >= ${since}
      AND timestamp < ${scanEnd}
      AND event_name IN (${eventList})
    LIMIT 1 BY project_id, event_id
  ) AS e
  WHERE ${notSuppressed}
  GROUP BY ${RESOLVED_PERSON_ALIAS}
)
WHERE level > 0${segmentFilter}
GROUP BY level`

  return {
    sql,
    params: params.values,
    warnings: funnelCostWarnings(definition, range),
  }
}
