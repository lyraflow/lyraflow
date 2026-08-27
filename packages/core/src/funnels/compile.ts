import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import { notSuppressedExpr } from '../privacy/suppression.js'
import { AST_VERSION } from '../segments/ast.js'
import { baseCte } from '../segments/base.js'
import {
  type CompiledQuery,
  MEMBER_PAGE_SIZE,
  compileSegment,
  memberProjection,
  traitsCte,
} from '../segments/compile.js'
import type { Cursor } from '../segments/cursor.js'
import { Params, chDateTime } from '../segments/params.js'
import { attributeColumns, wherePredicate } from '../segments/predicates.js'
import type { FunnelDefinition, FunnelStep } from './ast.js'
import { funnelSpine } from './spine.js'
import {
  FunnelValidationError,
  MAX_COMPILED_QUERY_BYTES,
  funnelCostWarnings,
  validateFunnel,
  validateRange,
} from './validate.js'

/**
 * One step's condition: the event name, ANDed with any predicates on that
 * event's own properties, ANDed with the person-set its `audience` compiles
 * to. Every value is bound; nothing is concatenated.
 *
 * The audience gate is CONSTANT PER PERSON, which is what makes it cheap
 * here: ClickHouse evaluates the `IN` subquery once and the per-row test is
 * a set membership. It belongs inside this condition rather than beside the
 * funnel-wide `segmentFilter` below -- there, it would remove the person
 * from the report; here, it stops them advancing and leaves them counted at
 * the step they did reach. See `funnels/ast.ts` on the field itself.
 */
function stepCondition(
  step: FunnelStep,
  params: Params,
  eventPlaceholder: (event: string) => string,
  audienceSql: (step: FunnelStep) => string | undefined,
  now: Date,
): string {
  const parts = [`event_name = ${eventPlaceholder(step.event)}`]
  for (const w of step.where ?? []) parts.push(wherePredicate(w, params, now))
  const gate = audienceSql(step)
  if (gate !== undefined) parts.push(gate)
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
  /**
   * Return the people at this step instead of the histogram. 1-indexed,
   * matching the `index` in a run response.
   *
   * `mode` picks the population: `'reached'` is `level >= step` -- everyone
   * who got at least that far, which is what a chart bar labelled with a
   * step's count means. `'dropped'` is `level = step` -- only those who
   * stopped exactly there, the population `/dropoff` has always returned.
   * Confusing the two answers a different question with full confidence: on
   * a real funnel the two counts differ by a factor of three.
   *
   * `select` picks the shape: `'ids'` is the bare (person, entered_at) list
   * `/dropoff` has always compiled -- no traits join, so an existing caller's
   * SQL is unchanged. `'members'` wraps it with the same member projection a
   * segment walk uses, joining `base` and `traits`. `'count'` is a single
   * `person_count`, uncursored and unpaged, for a caller that must compute a
   * count in the SAME request as the page rather than reuse a run's own
   * `steps[i].people` -- which was computed at a different instant.
   *
   * `'skipped'` is optional steps ONLY: reached the required step this one
   * branches off, and did not do this one inside the window. It is the
   * complement of `'reached'` at that branch point, and it is the list an
   * operator actually chases -- "who started a subscription and never
   * submitted a video".
   *
   * `'dropped'` on an optional step, and `'skipped'` on a required one, are
   * both refused by the route rather than answered approximately: "stopped
   * exactly at a step that is not on the chain" is not a population, and a
   * caller shown one would read it as `'skipped'`.
   */
  peopleAt?: {
    step: number
    mode: 'reached' | 'dropped' | 'skipped'
    select: 'ids' | 'members' | 'count'
    cursor?: Cursor
  }
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
  // Same rule as the segment scan (`behaviour.ts`): a step's attribute
  // predicate compiles to a bare column, so the column must be in this
  // subquery's projection -- and only the ones some step actually names are
  // added, because the alternative is fourteen extra columns read by every
  // funnel run in the product. Names come from a Zod enum over
  // `EVENT_COLUMN_FIELDS`, which is what makes this interpolation safe.
  const resolved = resolvedPersonExpr({ database, alias: 'e' })
  // Compiled here rather than passed in, unlike `segmentPersonSql`: an
  // audience is EMBEDDED in the definition, so it needs no database lookup
  // and there is nothing for the caller to do. The same `params` instance
  // is threaded through every one of them -- placeholder names are
  // positional (`p0`, `p1`, ...), so independently-numbered maps merged
  // afterwards would silently overwrite each other.
  //
  // `now`, not the range: a segment's window is anchored to now and this is
  // the segment grammar verbatim. The consequence for a run over an older
  // range is real and is stated in the builder, not hidden here.
  //
  // Keyed by the step OBJECT, not by index, so `conditions` and the
  // `minIf` that reuses `conditions[0]` cannot disagree about which gate
  // belongs to which step.
  const audienceByStep = new Map<FunnelStep, string>()
  for (const step of definition.steps) {
    if (step.audience === undefined) continue
    const persons = compileSegment({
      query: { ast_version: AST_VERSION, filter: step.audience },
      projectId,
      database,
      now,
      select: 'persons',
      params,
    })
    audienceByStep.set(step, `${resolved} IN (${persons.sql})`)
  }
  const audienceSql = (step: FunnelStep): string | undefined => audienceByStep.get(step)

  const attributes = attributeColumns(definition.steps.flatMap((s) => s.where ?? []))
  const attributeSelect = attributes.length > 0 ? `,\n           ${attributes.join(', ')}` : ''

  const conditions = definition.steps.map((s, i) => {
    const cond = stepCondition(s, params, eventPlaceholder, audienceSql, now)
    // Step 1 additionally bounds ENTRY to the range. Without it the extended
    // scan above would let someone whose first step lands after `until` enter
    // a funnel the caller did not ask about.
    return i === 0 ? `(${cond} AND timestamp < ${until})` : cond
  })
  // The required steps are the chain that conversion is measured over; each
  // optional step gets a chain of its own -- the required steps before it,
  // then itself. Every chain starts at `conditions[<first required>]`, which
  // carries the entry bound, so no chain can be entered outside the range.
  //
  // `validateFunnel` above has already refused an optional first step, so
  // that first required step is `conditions[0]`.
  const spine = funnelSpine(definition.steps)
  const spineConditions = spine.required.map((i) => conditions[i] as string)
  const branchChains = spine.optional.map((k) => {
    const rank = spine.placements[k]?.spineRank ?? 0
    return [
      ...spine.required.slice(0, rank).map((i) => conditions[i] as string),
      conditions[k] as string,
    ]
  })
  // The branch chain ends AT the optional step, which answers "did they do
  // it" and nothing else. A chart that draws the step as a node needs its
  // OUTGOING flow too, or the node is a dead end: people walk in and vanish.
  //
  // `null` when no required step follows -- `validateFunnel` refuses an
  // optional last step so the API cannot reach it, but `funnelSpine` is pure
  // over whatever it is handed and indexing past the end would be a crash
  // rather than a refusal.
  const fullChains = spine.optional.map((k) => {
    const rank = spine.placements[k]?.spineRank ?? 0
    const next = spine.required[rank]
    if (next === undefined) return null
    return [
      ...spine.required.slice(0, rank).map((i) => conditions[i] as string),
      conditions[k] as string,
      conditions[next] as string,
    ]
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

  // One aggregate per optional step, ALWAYS emitted -- including on a
  // people-list request that reads only one of them.
  //
  // Emitting only what a projection needs would save some per-person CPU and
  // reintroduce the seam this block exists to close: a second spelling of
  // the per-person pass is how one of them ends up without the suppression
  // filter. The cost is bounded by MAX_OPTIONAL_STEPS and is aggregate work
  // over rows already read, never another scan.
  const branchSelects = branchChains
    .map(
      (chain, j) =>
        `\n    windowFunnel(${windowParam})(toUInt64(toUnixTimestamp64Milli(timestamp)), ${chain.join(', ')}) AS branch_${j},`,
    )
    .join('')
  const fullSelects = fullChains
    .map((chain, j) =>
      chain === null
        ? ''
        : `\n    windowFunnel(${windowParam})(toUInt64(toUnixTimestamp64Milli(timestamp)), ${chain.join(', ')}) AS full_${j},`,
    )
    .join('')

  /**
   * The per-person pass, shared by both projections above it. Written once so
   * the histogram and the drop-off list cannot disagree about who reached
   * what — a second copy is how one of them ends up without the suppression
   * filter.
   */
  const perPerson = `
  SELECT
    ${resolved} AS ${RESOLVED_PERSON_ALIAS},
    windowFunnel(${windowParam})(toUInt64(toUnixTimestamp64Milli(timestamp)), ${spineConditions.join(', ')}) AS level,${branchSelects}${fullSelects}
    minIf(timestamp, ${spineConditions[0]}) AS entered_at
  FROM (
    SELECT project_id, anonymous_id, user_id, timestamp, event_name,
           properties, properties_num, event_id${attributeSelect}
    FROM events
    WHERE project_id = ${projectParam}
      AND timestamp >= ${since}
      AND timestamp < ${scanEnd}
      AND event_name IN (${eventList})
    LIMIT 1 BY project_id, event_id
  ) AS e
  WHERE ${notSuppressed}
  GROUP BY ${RESOLVED_PERSON_ALIAS}
`

  const people = opts.peopleAt

  /**
   * Every shape this function can return -- the histogram, and all three
   * `peopleAt` projections -- shares ONE `perPerson` subquery, which
   * ALWAYS carries every branch and full chain regardless of which shape
   * reads them (see the comment above `branchSelects`). That is the shared
   * RISK, not a shared size: measured on the same definition, `members` is
   * the largest of the four -- its two extra CTEs (`base`, `traits`) and
   * its wider projection add roughly 5KB over the histogram -- while `ids`
   * and `count` land a little BELOW it (`ids` has no traits join at all).
   * Each of the four is measured on its OWN assembled SQL, at its own
   * return site, for exactly that reason: a single check against the
   * histogram's size would be wrong for `members`, the path most likely to
   * cross the guard first.
   */
  const finalize = (sql: string): CompiledQuery => {
    const bytes = Buffer.byteLength(sql, 'utf8')
    if (bytes > MAX_COMPILED_QUERY_BYTES) {
      throw new FunnelValidationError(
        `this funnel compiles to a ${bytes}-byte query, past the ${MAX_COMPILED_QUERY_BYTES}-byte limit ClickHouse can parse; remove some \`where\` predicates, step audiences, or optional steps`,
        'steps',
      )
    }
    return { sql, params: params.values, warnings: funnelCostWarnings(definition, range) }
  }

  // Ordered newest-entrant first, tie-broken by person_id, and paged by a
  // strictly lexicographic keyset — collapsing that to `entered_at <` alone
  // would skip every remaining person sharing the boundary row's instant.
  // Not applied to the `count` shape: a count has no page to keep the cursor
  // for, and threading it in would bind a value the SQL never reads.
  const peopleAfter =
    people?.select !== 'count' && people?.cursor !== undefined
      ? ` AND (entered_at < ${params.add(people.cursor.lastSeen, 'DateTime64(3)')}` +
        ` OR (entered_at = ${params.add(people.cursor.lastSeen, 'DateTime64(3)')}` +
        ` AND ${RESOLVED_PERSON_ALIAS} > ${params.add(people.cursor.personId, 'String')}))`
      : ''

  if (people) {
    const placement = spine.placements[people.step - 1]

    // Every `params.add` sits INSIDE the branch that reads it. A placeholder
    // the SQL never references is a bound value the next reader has to prove
    // is harmless, and the two paths here bind different things.
    let levelPredicate: string
    if (placement?.branch !== undefined) {
      const branchLevel = params.add(placement.branch.level, 'UInt32')
      levelPredicate =
        people.mode === 'skipped'
          ? `level >= ${params.add(placement.spineRank, 'UInt32')} AND branch_${placement.branch.index} < ${branchLevel}`
          : `branch_${placement.branch.index} >= ${branchLevel}`
    } else {
      // BY SPINE RANK, never by definition position. The two agree exactly
      // until an optional step sits before this one, so binding the position
      // compiles a query that runs, returns nobody, and looks fine.
      const level = params.add(placement?.spineRank ?? people.step, 'UInt32')
      // `>=` for "reached", `=` for "stopped here". The two differ by a
      // factor of three on a real funnel, so this is the one line where a
      // wrong operator answers a different question with full confidence.
      levelPredicate = people.mode === 'reached' ? `level >= ${level}` : `level = ${level}`
    }

    if (people.select === 'count') {
      return finalize(`SELECT count() AS person_count
FROM (${perPerson})
WHERE ${levelPredicate}${segmentFilter}`)
    }

    if (people.select === 'members') {
      // Both CTEs, not just traits: memberProjection selects first_seen,
      // last_seen and the CONTEXT_FIELDS columns, which come from `base` --
      // joining only `traits` would reference columns nothing in the query
      // produces. `base` and the funnel's per-person pass alias the join key
      // identically (RESOLVED_PERSON_ALIAS), which is what makes `USING`
      // valid here.
      const ctes = [
        baseCte({ database, projectId, params }),
        traitsCte({ database, projectId, params }),
      ]
      return finalize(`WITH
  ${ctes.join(',\n  ')}
SELECT
  ${memberProjection()},
  f.entered_at AS entered_at
FROM (${perPerson}) AS f
LEFT JOIN base USING (${RESOLVED_PERSON_ALIAS})
LEFT JOIN traits USING (${RESOLVED_PERSON_ALIAS})
WHERE ${levelPredicate}${segmentFilter}${peopleAfter}
ORDER BY entered_at DESC, ${RESOLVED_PERSON_ALIAS} ASC
LIMIT ${MEMBER_PAGE_SIZE}`)
    }

    // select === 'ids' -- exactly what `/dropoff` has always compiled, with
    // only the level predicate substituted. No traits join: a second scan of
    // person_traits on every existing caller's request is not this task's to
    // add.
    return finalize(`SELECT ${RESOLVED_PERSON_ALIAS}, entered_at
FROM (${perPerson})
WHERE ${levelPredicate}${segmentFilter}${peopleAfter}
ORDER BY entered_at DESC, ${RESOLVED_PERSON_ALIAS} ASC
LIMIT ${MEMBER_PAGE_SIZE}`)
  }

  const optionalCounts = spine.optional
    .map((k, j) => {
      const level = params.add(spine.placements[k]?.branch?.level ?? 1, 'UInt32')
      return `,\n  countIf(branch_${j} >= ${level}) AS optional_${j}`
    })
    .join('')

  // `branch.level + 1` is the full chain's own length: the branch chain
  // reaches `spineRank + 1`, and the full chain adds exactly one condition.
  const continuedCounts = spine.optional
    .map((k, j) => {
      if (fullChains[j] === null) return ''
      const level = params.add((spine.placements[k]?.branch?.level ?? 1) + 1, 'UInt32')
      return `,\n  countIf(full_${j} >= ${level}) AS continued_${j}`
    })
    .join('')

  return finalize(`SELECT
  level,
  count() AS people,
  countIf(entered_at > ${partialBoundary}) AS partial${optionalCounts}${continuedCounts}
FROM (${perPerson})
WHERE level > 0${segmentFilter}
GROUP BY level`)
}
