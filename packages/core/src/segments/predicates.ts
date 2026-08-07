import type { Behavior, Context, FilterNode, Lifecycle, Trait } from './ast.js'
import { CONTEXT_COLUMNS } from './base.js'
import type { ChType, Params } from './params.js'

interface Ctx {
  params: Params
  aliasFor: Map<Behavior, string>
}

/** `lhs op value`, with `between` taking two bounds. Every value is bound. */
function compare(
  lhs: string,
  operator: string,
  value: unknown,
  type: ChType,
  params: Params,
): string {
  if (operator === 'between') {
    const [lo, hi] = value as [string | number, string | number]
    return `${lhs} BETWEEN ${params.add(lo, type)} AND ${params.add(hi, type)}`
  }
  return `${lhs} ${operator} ${params.add(value as string | number, type)}`
}

function traitExpr(n: Trait, ctx: Ctx): string {
  const numeric =
    typeof n.value === 'number' || (Array.isArray(n.value) && typeof n.value[0] === 'number')
  const key = ctx.params.add(n.key, 'String')

  if (!numeric) return compare(`t_str[${key}]`, n.operator, n.value, 'String', ctx.params)

  // A string trait leaves value_num at its default 0, so without the has_num
  // guard a predicate like `seats < 5` would match every person holding any
  // string trait under that key. This is the same class of defect as trusting
  // a dictionary default.
  const cmp = compare(`t_num[${key}]`, n.operator, n.value, 'Float64', ctx.params)
  return `(t_has_num[${key}] = 1 AND ${cmp})`
}

function contextExpr(n: Context, ctx: Ctx): string {
  // Safe as a bare identifier ONLY because n.field is a Zod enum over
  // CONTEXT_FIELDS and this record is keyed by that same union — a caller
  // cannot name a column that is not in the allowlist.
  const column = CONTEXT_COLUMNS[n.field][n.scope]
  return compare(column, n.operator, n.value, 'String', ctx.params)
}

function lifecycleExpr(n: Lifecycle, ctx: Ctx): string {
  return compare(n.field, n.operator, n.value, 'DateTime64(3)', ctx.params)
}

/**
 * A behavioural leaf reads the alias its aggregate was given in the single
 * events pass.
 *
 * `coalesce(alias, 0)` is what makes negation cheap: a person with no
 * matching events has no row in the behavioural CTE at all, so the LEFT JOIN
 * leaves the alias NULL. Coalescing to 0 turns "no row" into "count of zero",
 * which the operator then compares normally — so `NOT (count >= 1)` becomes
 * `NOT (0 >= 1)` and is true, without an anti-join. That is the spec's
 * requirement that "never did X" cost the same as "did X".
 */
function behaviorExpr(n: Behavior, ctx: Ctx): string {
  const alias = ctx.aliasFor.get(n)
  if (alias === undefined) {
    // Programmer error, not user input: every behavioural node in the tree
    // must have been passed to behaviourCte. Failing loudly here beats
    // emitting SQL that references an undefined column.
    throw new Error('behaviour node was not registered with behaviourCte')
  }
  return compare(`coalesce(${alias}, 0)`, n.operator, n.value, 'Float64', ctx.params)
}

/** One boolean SQL expression for the whole tree. */
export function treeExpr(node: FilterNode, ctx: Ctx): string {
  switch (node.kind) {
    case 'group': {
      const op = node.op === 'and' ? ' AND ' : ' OR '
      // Always parenthesised: an unparenthesised OR inside an AND is the
      // classic way a compiled filter silently returns the wrong population.
      return `(${node.children.map((c) => treeExpr(c, ctx)).join(op)})`
    }
    case 'not':
      return `NOT (${treeExpr(node.child, ctx)})`
    case 'trait':
      return traitExpr(node, ctx)
    case 'context':
      return contextExpr(node, ctx)
    case 'lifecycle':
      return lifecycleExpr(node, ctx)
    case 'behavior':
      return behaviorExpr(node, ctx)
  }
}
