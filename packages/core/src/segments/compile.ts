import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import type { Behavior, FilterNode, SegmentQuery } from './ast.js'
import { baseCte } from './base.js'
import { behaviourCte } from './behaviour.js'
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
 *
 * Validation runs BEFORE any SQL is built, so a tree past the caps costs a
 * tree walk rather than a query.
 */
export function compileSegment(opts: {
  query: SegmentQuery
  projectId: number
  database: string
  now: Date
}): CompiledQuery {
  const { query, projectId, database, now } = opts

  validateTree(query)
  const warnings = costWarnings(query)

  const params = new Params()
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
      CAST((groupArray(trait_key), groupArray(value_str)), 'Map(String, String)')  AS t_str,
      CAST((groupArray(trait_key), groupArray(value_num)), 'Map(String, Float64)') AS t_num,
      CAST((groupArray(trait_key), groupArray(has_num)),   'Map(String, UInt8)')   AS t_has_num
    FROM (
      SELECT
        anonymous_id, user_id, project_id, trait_key,
        argMaxMerge(value_str) AS value_str,
        argMaxMerge(value_num) AS value_num,
        argMaxMerge(has_num)   AS has_num,
        now() AS timestamp
      FROM person_traits
      WHERE project_id = ${params.add(projectId, 'UInt32')}
      GROUP BY project_id, anonymous_id, user_id, trait_key
    ) AS tr
    GROUP BY ${RESOLVED_PERSON_ALIAS}
  )`

  const ctes = [base, traits, pass.cte].filter((c): c is string => c !== null).join(',\n  ')

  const behJoin = pass.cte ? `LEFT JOIN beh USING (${RESOLVED_PERSON_ALIAS})` : ''

  const suppressed =
    `dictHas('${database}.suppressed_persons', ` +
    `(${params.add(projectId, 'UInt32')}, base.${RESOLVED_PERSON_ALIAS})) = 0`

  return {
    sql: `WITH
  ${ctes}
SELECT count() AS person_count
FROM base
LEFT JOIN traits USING (${RESOLVED_PERSON_ALIAS})
${behJoin}
WHERE ${suppressed}
  AND (${where})`,
    params: params.values,
    warnings,
  }
}
