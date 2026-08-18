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
 * Traits are deliberately absent: a per-person map of arbitrary size,
 * multiplied by a hundred rows, is unbounded by construction.
 */
function memberProjection(): string {
  const context = CONTEXT_FIELDS.map((f) => `${CONTEXT_COLUMNS[f].latest} AS ${f}`)
  return ['person_id', 'first_seen', 'last_seen', ...context].join(',\n  ')
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

  const where = treeExpr(query.filter, { params, aliasFor: pass.aliasFor })

  // Traits are unpivoted one row per key, so they are folded back into maps
  // here — the predicates read them as t_str[key] / t_num[key].
  //
  // person_traits is keyed by raw identity, exactly like device_index, so the
  // rows have to be resolved to a person before they can be grouped. `now()
  // AS timestamp` exists because resolvedPersonExpr reads a column of that
  // name: traits carry no meaningful event time, and resolving them at the
  // current instant is the correct reading of "this person's traits today".
  const traits = `traits AS (
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
