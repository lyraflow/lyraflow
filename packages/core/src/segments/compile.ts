import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import { notSuppressedExpr } from '../privacy/suppression.js'
import type { Behavior, FilterNode, SegmentQuery } from './ast.js'
import { CONTEXT_FIELDS } from './ast.js'
import { CONTEXT_COLUMNS, baseCte } from './base.js'
import { behaviourCte } from './behaviour.js'
import type { Cursor } from './cursor.js'
import { MEMBER_PAGE_SIZE } from './limits.js'
import { Params } from './params.js'
import { treeExpr } from './predicates.js'
import { type CostWarning, costWarnings, validateTree } from './validate.js'

export interface CompiledQuery {
  sql: string
  params: Record<string, unknown>
  /** Non-fatal; the query runs. Shown in the builder before it is run. */
  warnings: CostWarning[]
}

function collectBehaviors(node: FilterNode, out: Behavior[]): void {
  if (node.kind === 'group') for (const c of node.children) collectBehaviors(c, out)
  else if (node.kind === 'not') collectBehaviors(node.child, out)
  else if (node.kind === 'behavior') out.push(node)
}

// Defined in `./limits.js` so the web UI can import them without reaching
// through this module; re-exported here so every existing importer of
// `compile.js` is unchanged and there is exactly one definition (#120).
export { MEMBER_PAGE_SIZE, MEMBER_WINDOW_MAX } from './limits.js'

/**
 * The member projection.
 *
 * Context columns are aliased to their FIELD name, taken from CONTEXT_FIELDS,
 * so the JSON a client receives is keyed the same way the filter tree is. Both
 * sides of that mapping are compile-time allowlists, so the aliases are safe
 * identifiers by construction and no request data reaches the SELECT list.
 *
 * `latest` scope only. The `first_touch` values are filterable but not
 * returned: a People screen's default columns are current values, and
 * returning both doubles a response that is already a hundred rows wide.
 * Note that for referrer and the UTM trio the two scopes read the same
 * column, so those return first-touch values — documented in the README.
 *
 * Traits ARE returned, bounded — see `boundedTraitMap` for the bound and for
 * why this reversed. They cost no extra join: the `traits` CTE is built and
 * LEFT JOINed for every compiled segment already, because predicates read it.
 *
 * `identified` is `base`'s own column (see base.ts's `base` CTE) — reading it
 * unqualified here is what lets this SAME projection compile unchanged for
 * the funnel people query, which joins `base` by name rather than embedding
 * it: a version of this column computed here instead would need re-deriving
 * (or re-joining) wherever `memberProjection` is called, and there are two
 * such call sites (`compileSegment`, `funnels/compile.ts`'s members branch).
 */
/**
 * How many of one person's traits a member row carries.
 *
 * A bound rather than none, and the reason is the comment this replaced:
 * "traits are deliberately absent -- a per-person map of arbitrary size,
 * multiplied by a hundred rows, is unbounded by construction". That was very
 * nearly right. The only thing capping distinct trait keys is
 * `MAX_PROPERTY_KEYS_PER_EVENT_NAME` in the ingest limiter, applied to
 * `$identify` -- and that limiter's own doc calls itself "an in-memory view
 * of cardinality observed BY THIS PROCESS SINCE IT STARTED", so it resets on
 * every restart. A cap that a redeploy lifts is not a bound this query may
 * rely on.
 *
 * Fifty is far above what an `identify()` call carries in practice and far
 * below what would make a hundred-row page expensive. Whatever the number,
 * the point is that it is stated here, applied in SQL, and reported: the row
 * also carries `trait_total`, so a reader is told what was held back instead
 * of being shown a truncated list that looks whole.
 */
export const TRAITS_PER_MEMBER_MAX = 50

/**
 * One person's traits of a given kind, as a `Map`, capped and deterministic.
 *
 * Three things this has to get right, and only the first is obvious:
 *
 * - **The `t_has_num` filter is load-bearing.** The traits CTE builds `t_str`
 *   and `t_num` over the SAME key set, so every string trait has an entry in
 *   `t_num` sitting at its `Float64` default of 0. Selecting the raw maps
 *   would give every person a `plan: 0` next to their real `plan: "pro"` --
 *   the same defect `traitExpr` guards against when it compares a numeric
 *   trait, for the same reason.
 * - **Sorted before slicing.** A `Map`'s key order is whatever `groupArray`
 *   produced, so an unsorted slice would return a different fifty on
 *   different runs of the same query, and page two of a walk could disagree
 *   with page one about which traits a person has.
 * - **Values looked up by key, not sliced in parallel.** Slicing keys and
 *   values as two independent arrays only lines up while both are in the
 *   same order, which is an assumption about `mapKeys`/`mapValues` that
 *   nothing here enforces. `arrayMap(k -> m[k], keys)` cannot mispair.
 *
 * No request data reaches this SQL: it names only CTE columns and a
 * compile-time integer.
 */
function boundedTraitMap(kind: 'string' | 'number'): string {
  const source = kind === 'string' ? 't_str' : 't_num'
  const hasNum = kind === 'string' ? '0' : '1'
  const chType = kind === 'string' ? 'String' : 'Float64'
  const mine = `mapFilter((k, v) -> t_has_num[k] = ${hasNum}, ${source})`
  const keys = `arraySlice(arraySort(mapKeys(${mine})), 1, ${TRAITS_PER_MEMBER_MAX})`
  return `CAST((${keys}, arrayMap(k -> ${source}[k], ${keys})), 'Map(String, ${chType})')`
}

export function memberProjection(): string {
  const context = CONTEXT_FIELDS.map((f) => `${CONTEXT_COLUMNS[f].latest} AS ${f}`)
  return [
    'person_id',
    'first_seen',
    'last_seen',
    'identified',
    ...context,
    `${boundedTraitMap('string')} AS traits`,
    `${boundedTraitMap('number')} AS traits_num`,
    // NOT the size of either bounded map above: this is how many the person
    // actually has, so a reader can be told what was held back rather than
    // shown a truncated list that looks complete. `toUInt32` because a UInt64
    // reaches JSON as a STRING -- `"4"`, not `4` -- and a count that arrives
    // as a string is a count someone compares with `>` against a number.
    'toUInt32(length(t_has_num)) AS trait_total',
  ].join(',\n  ')
}

/**
 * The per-person trait maps, as a CTE.
 *
 * Exported for the same reason `wherePredicate` is: two engines compile it --
 * the segment members walk and the funnel people walk -- and a second copy
 * would drift first at `t_has_num`, the flag that decides whether a trait is
 * read as a number or a string. A person whose `plan` trait reads `"3"` in
 * one list and `3` in the other is the kind of disagreement nobody notices
 * until a comparison silently stops matching.
 *
 * `now()` as the timestamp is deliberate and unchanged: traits carry no
 * meaningful event time, and resolving them at the current instant is the
 * correct reading of "this person's traits today".
 */
export function traitsCte(opts: { database: string; projectId: number; params: Params }): string {
  const { database, projectId, params } = opts
  return `traits AS (
    SELECT
      ${resolvedPersonExpr({ database, alias: 'tr' })} AS ${RESOLVED_PERSON_ALIAS},
      CAST((groupArray(trait_key), groupArray(m_value_str)), 'Map(String, String)')  AS t_str,
      CAST((groupArray(trait_key), groupArray(m_value_num)), 'Map(String, Float64)') AS t_num,
      CAST((groupArray(trait_key), groupArray(m_has_num)),   'Map(String, UInt8)')   AS t_has_num
    FROM (
      SELECT
        anonymous_id, user_id, project_id, trait_key,
        argMaxMerge(value_str) AS m_value_str,
        argMaxMerge(value_num) AS m_value_num,
        argMaxMerge(has_num)   AS m_has_num,
        now() AS timestamp
      FROM person_traits
      WHERE project_id = ${params.add(projectId, 'UInt32')}
      GROUP BY project_id, anonymous_id, user_id, trait_key
    ) AS tr
    GROUP BY ${RESOLVED_PERSON_ALIAS}
  )`
}

/**
 * Compiles a filter tree into one counting query.
 *
 * Two things are injected here and are unreachable from the AST, which is
 * what makes them guarantees rather than conventions:
 *
 *   project_id  — bound from the authenticated caller's project, never from
 *                 the tree. There is no AST node that can express it, so no
 *                 request can widen a query to another tenant.
 *   suppression — every result excludes people on the suppression list. A
 *                 caller cannot opt out because there is nothing to opt out
 *                 of; the predicate is added after the tree is compiled.
 *                 Time-scoped, not presence-only: every result excludes
 *                 events at or before a person's deletion boundary, and
 *                 excludes the person entirely when nothing of theirs
 *                 survives it.
 *
 * Validation runs BEFORE any SQL is built, so a tree past the caps costs a
 * tree walk rather than a query.
 */
export function compileSegment(opts: {
  query: SegmentQuery
  projectId: number
  database: string
  now: Date
  /**
   * `persons` returns the bare person set with no ordering or page limit. It
   * exists so another engine can embed this population as a subquery — the
   * funnel compiler restricting a funnel to a segment — rather than
   * assembling equivalent SQL by hand and inheriting none of the guarantees
   * this function applies.
   */
  select?: 'count' | 'members' | 'persons'
  cursor?: Cursor
  /**
   * Continue an existing parameter sequence instead of starting a new one.
   *
   * Required when this query will be embedded in another compiled query:
   * names are positional (`p0`, `p1`, …), so two independently-numbered maps
   * merged after the fact would silently overwrite each other. Threading one
   * instance makes that impossible rather than merely unlikely.
   */
  params?: Params
}): CompiledQuery {
  const { query, projectId, database, now, select = 'count', cursor } = opts

  validateTree(query)
  const warnings = costWarnings(query)

  const params = opts.params ?? new Params()
  const base = baseCte({ database, projectId, params })

  const behaviors: Behavior[] = []
  collectBehaviors(query.filter, behaviors)
  const pass = behaviourCte({ database, projectId, behaviors, params, now })

  const where = treeExpr(query.filter, { params, aliasFor: pass.aliasFor, now })

  // Traits are unpivoted one row per key, so they are folded back into maps
  // here — the predicates read them as t_str[key] / t_num[key].
  //
  // person_traits is keyed by raw identity, exactly like device_index, so the
  // rows have to be resolved to a person before they can be grouped. See
  // `traitsCte`'s own doc comment for why it is exported and for the `now()`
  // note.
  const traits = traitsCte({ database, projectId, params })

  const ctes = [base, traits, pass.cte].filter((c): c is string => c !== null).join(',\n  ')

  const behJoin = pass.cte ? `LEFT JOIN beh USING (${RESOLVED_PERSON_ALIAS})` : ''

  // TIME-SCOPED, not permanent. The person survives if they have activity
  // after their boundary: someone whose entire history predates the request
  // disappears; someone who kept using the customer's application stays.
  //
  // The comparison is the person-level `last_seen`, which is derived from
  // device_index — pre-aggregated per (device, month), so a month straddling
  // the boundary cannot be split. A person whose activity straddles it may
  // therefore still carry erased events inside these aggregates until the
  // purge runs, typically minutes. Event-level reads (the behavioural pass
  // below, the person read, the export) are exact throughout. Suppression is
  // a shield until the purge completes; the purge is the guarantee. The
  // README states that window rather than implying an exactness the storage
  // cannot give.
  const suppressed = notSuppressedExpr({
    database,
    projectId,
    params,
    person: `base.${RESOLVED_PERSON_ALIAS}`,
    instant: 'base.last_seen',
  })

  // Keyset continuation on the same (last_seen DESC, person_id ASC) ordering
  // the projection uses. Strictly lexicographic: a row is "after" the cursor
  // if its last_seen is older, OR its last_seen is identical and its
  // person_id sorts later. Collapsing this to `last_seen <` alone would skip
  // every remaining person who shares the boundary row's timestamp.
  const after =
    select === 'members' && cursor
      ? ` AND (last_seen < ${params.add(cursor.lastSeen, 'DateTime64(3)')}` +
        ` OR (last_seen = ${params.add(cursor.lastSeen, 'DateTime64(3)')}` +
        ` AND person_id > ${params.add(cursor.personId, 'String')}))`
      : ''

  const projection =
    select === 'members'
      ? `SELECT\n  ${memberProjection()}`
      : select === 'persons'
        ? `SELECT ${RESOLVED_PERSON_ALIAS}`
        : 'SELECT count() AS person_count'

  const tail =
    select === 'members'
      ? `\nORDER BY last_seen DESC, person_id ASC\nLIMIT ${MEMBER_PAGE_SIZE}`
      : ''

  return {
    sql: `WITH
  ${ctes}
${projection}
FROM base
LEFT JOIN traits USING (${RESOLVED_PERSON_ALIAS})
${behJoin}
WHERE ${suppressed}
  AND (${where})${after}${tail}`,
    params: params.values,
    warnings,
  }
}
