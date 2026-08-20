import type {
  Behavior,
  Context,
  EventColumnField,
  FilterNode,
  Lifecycle,
  Trait,
  WherePredicate,
} from './ast.js'
import { CONTEXT_COLUMNS } from './base.js'
import { lifecycleInstant } from './instants.js'
import { type ChType, type Params, chDateTime } from './params.js'

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

/**
 * A predicate on one event — either on a key in its own property bag, or on
 * one of its columns.
 *
 * The two halves have opposite injection stories, and that is why they are
 * separate shapes in the AST rather than one shape with a flag:
 *
 * - a property's name is a MAP KEY, not a column, so it is a bound parameter
 *   like any other value and there is no identifier surface at all;
 * - an attribute's name IS a column and is interpolated bare. Safe for
 *   exactly the reason `contextExpr` below is safe: `w.attribute` is typed
 *   `EventColumnField`, a Zod enum over `EVENT_COLUMN_FIELDS`, so a caller
 *   cannot name a column the allowlist does not contain and there is no
 *   runtime check here that a later edit could drop.
 *
 * Every attribute column is `String`/`LowCardinality(String)` in
 * `002_events.sql` and the AST admits only string values for them, so the
 * comparison type is `String` unconditionally — there is no numeric branch
 * to get wrong.
 *
 * The caller must have PROJECTED the column. Both scans select an explicit
 * list (`behaviour.ts`, `funnels/compile.ts`) and add only the attributes
 * their tree references, via `attributeColumns` below; a column named here
 * and missing there is a query that fails to parse rather than one that
 * answers wrongly.
 *
 * Exported because two engines compile it: the segment behavioural pass, and
 * the funnel step compiler. A funnel step and a segment behaviour's `where`
 * are the same idea — a claim about one event — and a second implementation
 * would be two grammars for it, drifting first at the operator list.
 */
export function wherePredicate(w: WherePredicate, params: Params): string {
  if (w.source === 'attribute') {
    return compare(w.attribute, w.operator, w.value, 'String', params)
  }
  const numeric =
    typeof w.value === 'number' || (Array.isArray(w.value) && typeof w.value[0] === 'number')
  const bag = numeric ? 'properties_num' : 'properties'
  const type = numeric ? 'Float64' : 'String'
  const key = params.add(w.property, 'String')
  return compare(`${bag}[${key}]`, w.operator, w.value, type, params)
}

/**
 * The columns a set of `where` predicates needs projected, deduplicated and
 * in a stable order.
 *
 * Every scan of `events` in this codebase selects an EXPLICIT column list
 * inside a subquery, so an attribute predicate can only read a column the
 * scan asked for. This is what both engines call to find out which ones.
 *
 * Referenced columns only, never all fourteen. `events` is the one table
 * where the cost is real: it is columnar, it is the hot path, and every
 * segment evaluation in the product would otherwise read fourteen more
 * columns to serve the queries that use none of them. `compile.test.ts`
 * pins that a column appears only when a predicate names it, which is what
 * stops "just project all of them" coming back later as a tidy-up.
 *
 * Sorted so the generated SQL is stable for a given tree — two calls with
 * the same predicates in a different order produce the same query text,
 * which is what makes the compiler's own tests readable.
 */
export function attributeColumns(predicates: Iterable<WherePredicate>): EventColumnField[] {
  const out = new Set<EventColumnField>()
  for (const w of predicates) if (w.source === 'attribute') out.add(w.attribute)
  return [...out].sort()
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

/**
 * Lifecycle bounds are instants, and the caller writes them as ISO-8601
 * strings. They are reformatted into ClickHouse's DateTime64(3) literal
 * shape here rather than bound as written — an ISO string's trailing `Z` is
 * rejected by the parameter parser. The AST already refuses a value that is
 * not a parseable datetime, so `new Date` cannot produce an invalid date at
 * this point.
 */
function lifecycleExpr(n: Lifecycle, ctx: Ctx): string {
  // `lifecycleInstant`, not `new Date`. A zone-less value is UTC (#124); a
  // bare `new Date` resolved it in whatever zone the SERVER thinks it is in,
  // so the same stored segment matched different people on different hosts.
  const toCh = (v: unknown) => chDateTime(lifecycleInstant(String(v)))
  if (n.operator === 'between') {
    const [lo, hi] = n.value as [string, string]
    return (
      `${n.field} BETWEEN ${ctx.params.add(toCh(lo), 'DateTime64(3)')}` +
      ` AND ${ctx.params.add(toCh(hi), 'DateTime64(3)')}`
    )
  }
  return `${n.field} ${n.operator} ${ctx.params.add(toCh(n.value), 'DateTime64(3)')}`
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
