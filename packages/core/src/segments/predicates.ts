import type {
  Behavior,
  ComparisonOperator,
  Context,
  EventColumnField,
  FilterNode,
  Lifecycle,
  Operator,
  RelativeOperator,
  RelativeWindow,
  SetOperator,
  TextOperator,
  Trait,
  WherePredicate,
} from './ast.js'
import { BOOLEAN_OPERATORS, RELATIVE_OPERATORS, SET_OPERATORS, TEXT_OPERATORS } from './ast.js'
import { CONTEXT_COLUMNS } from './base.js'
import { lifecycleInstant } from './instants.js'
import { type ChType, type Params, chDateTime } from './params.js'

interface Ctx {
  params: Params
  aliasFor: Map<Behavior, string>
  /**
   * The instant a relative-date operator counts back from.
   *
   * Threaded in rather than read from the clock here, for the reason
   * `behaviour.ts` threads it into `windowStart`: a compiler that calls
   * `new Date()` emits different SQL on every invocation, so no test can pin
   * the bound it produced and two halves of one query can disagree about
   * when "now" was.
   */
  now: Date
}

/**
 * Narrows a predicate node to the member of its clause union whose operator
 * is in `ops`.
 *
 * ONE guard rather than a cast at each of the six targets. Every predicate in
 * the AST is `{…target fields} & (comparison | text | set | boolean |
 * relative)`, and the five families' operator enums are disjoint — so
 * membership in one of them IS the discriminator, and `Extract` recovers the
 * exact member, including whether it has a `value` at all and what that value
 * holds. The alternative was `n.value as string` in six places, which is the
 * shape that keeps compiling after a family's value type changes.
 */
function isFamily<T extends { operator: Operator }, F extends Operator>(
  node: T,
  ops: readonly F[],
): node is Extract<T, { operator: F }> {
  return (ops as readonly Operator[]).includes(node.operator)
}

/** `lhs op value`, with `between` taking two bounds. Every value is bound. */
function compare(
  lhs: string,
  operator: ComparisonOperator,
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
 * Substring matching, case-insensitively, on both sides.
 *
 * `lowerUTF8` rather than `lower`: `lower` folds ASCII only, so a Greek or
 * accented campaign name would match case-sensitively while an English one
 * did not — a difference nobody would attribute to the operator. The cost is
 * a full scan either way; these run inside queries that are already scanning.
 *
 * **It is not complete folding, and the gap was measured rather than
 * assumed.** Against ClickHouse 24.8: `lowerUTF8('ΑΘΗΝΑ')` is `'αθηνα'` and
 * `lowerUTF8('ÇÖĞ')` is `'çöğ'`, but `lowerUTF8('İSTANBUL')` keeps its
 * dotted `İ`, so `contains istanbul` does NOT match `İSTANBUL`. That is a
 * limit of the function, not of this compiler — folding it here would mean
 * shipping a case table — and it is recorded so the next reader does not
 * conclude from `lowerUTF8` that every alphabet is covered.
 *
 * **A negation matches an ABSENT value.** `properties['plan']` is `''` for a
 * person with no `plan` at all (a ClickHouse `Map` returns the value type's
 * default), so `plan not_contains "pro"` is true for someone who has never
 * had a plan. That is the same reading `!=` has always had here, kept
 * deliberately rather than special-cased: the operator that separates absent
 * from empty is `is_set`, and having two operators quietly mean it would make
 * `is_set` look redundant.
 */
function textExpr(lhs: string, operator: TextOperator, value: string, params: Params): string {
  const hay = `lowerUTF8(${lhs})`
  const needle = `lowerUTF8(${params.add(value, 'String')})`
  switch (operator) {
    case 'contains':
      return `position(${hay}, ${needle}) > 0`
    case 'not_contains':
      return `position(${hay}, ${needle}) = 0`
    case 'starts_with':
      return `startsWith(${hay}, ${needle})`
    case 'not_starts_with':
      return `NOT startsWith(${hay}, ${needle})`
    case 'ends_with':
      return `endsWith(${hay}, ${needle})`
    case 'not_ends_with':
      return `NOT endsWith(${hay}, ${needle})`
    default:
      return operator satisfies never
  }
}

/**
 * Presence, from a caller-supplied test of it.
 *
 * The test differs per target and that difference is the whole point of this
 * family (#193): on a `Map` it is `mapContains`, because an absent key and a
 * key holding `''` read back identically and no comparison can separate
 * them; on a column it is an emptiness test, because the column always
 * exists and "set" can only mean "has a value".
 */
function setExpr(present: string, operator: SetOperator): string {
  return operator === 'is_set' ? present : `NOT (${present})`
}

/**
 * `is true` / `is false`, as sugar over the text ingest actually stored.
 *
 * `routeProperties` writes a boolean as exactly `'true'` or `'false'`
 * (`ingest/properties.ts`), so this compares against those two strings and
 * nothing else. It deliberately does NOT also accept `'1'`, `'yes'` or `'on'`:
 * those are values a caller sent as strings, and matching them would make
 * `is true` mean something the stored type does not support — which is the
 * misreading #67 closed rather than one to reopen here.
 */
function booleanExpr(lhs: string, operator: 'is_true' | 'is_false', params: Params): string {
  return `${lhs} = ${params.add(operator === 'is_true' ? 'true' : 'false', 'String')}`
}

/**
 * `in the last N hours/days`, resolved to an absolute instant against
 * `ctx.now` — the same resolution `behaviour.ts`'s `windowStart` performs for
 * a `last` window, and for the same reason.
 *
 * `nullable` says whether the date expression can be NULL, which it can
 * whenever the date came out of a `Map` and had to be parsed: a trait or
 * property holding `"soon"` parses to NULL, and so does one that is simply
 * absent. `ifNull(…, 0)` makes that a definite non-match for `in_last` and a
 * definite match for `not_in_last`, rather than a NULL that three-valued
 * logic then drops from BOTH — which would make the two operators
 * non-complementary and lose those people from every result.
 */
function relativeExpr(
  dateExpr: string,
  operator: RelativeOperator,
  window: RelativeWindow,
  ctx: Ctx,
  nullable: boolean,
): string {
  const ms = window.unit === 'hours' ? window.n * 3_600_000 : window.n * 86_400_000
  const from = ctx.params.add(chDateTime(new Date(ctx.now.getTime() - ms)), 'DateTime64(3)')
  const cmp = `${dateExpr} >= ${from}`
  const definite = nullable ? `ifNull(${cmp}, 0)` : `(${cmp})`
  return operator === 'in_last' ? definite : `NOT ${definite}`
}

/**
 * A stored string read as a date.
 *
 * `…OrNull`, never the throwing form: the value is arbitrary caller data
 * that merely might be a date, and a parse failure must narrow the result
 * rather than fail the whole query for everyone else in the population.
 */
function asDate(lhs: string): string {
  return `parseDateTime64BestEffortOrNull(${lhs})`
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
 * The OPERATOR is interpolated bare too, and is safe for the same reason:
 * every one reaching here is a member of a Zod enum over one of the five
 * family arrays, and each family has its own compilation below rather than
 * being pasted between an lhs and a value.
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
export function wherePredicate(w: WherePredicate, params: Params, now: Date): string {
  const ctx: Ctx = { params, aliasFor: new Map(), now }

  if (w.source === 'attribute') {
    // A column, so presence is emptiness and there is no date or flag to read
    // — `columnClause` admits neither family, which is what makes the two
    // missing branches here unreachable rather than forgotten.
    if (isFamily(w, TEXT_OPERATORS)) return textExpr(w.attribute, w.operator, w.value, params)
    if (isFamily(w, SET_OPERATORS)) return setExpr(`${w.attribute} != ''`, w.operator)
    return compare(w.attribute, w.operator, w.value, 'String', params)
  }

  const key = params.add(w.property, 'String')
  const str = `properties[${key}]`

  if (isFamily(w, TEXT_OPERATORS)) return textExpr(str, w.operator, w.value, params)
  if (isFamily(w, BOOLEAN_OPERATORS)) return booleanExpr(str, w.operator, params)
  if (isFamily(w, RELATIVE_OPERATORS)) {
    return relativeExpr(asDate(str), w.operator, w.value, ctx, true)
  }
  if (isFamily(w, SET_OPERATORS)) {
    // BOTH bags. Routing is per VALUE (`ingest/properties.ts`), so the same
    // key lands in `properties` for one event and `properties_num` for
    // another; a presence test against one bag alone would report a numeric
    // property as unset.
    return setExpr(
      `(mapContains(properties, ${key}) OR mapContains(properties_num, ${key}))`,
      w.operator,
    )
  }

  const numeric =
    typeof w.value === 'number' || (Array.isArray(w.value) && typeof w.value[0] === 'number')
  const bag = numeric ? `properties_num[${key}]` : str
  const type = numeric ? 'Float64' : 'String'
  return compare(bag, w.operator, w.value, type, params)
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
  const key = ctx.params.add(n.key, 'String')
  const str = `t_str[${key}]`

  if (isFamily(n, TEXT_OPERATORS)) return textExpr(str, n.operator, n.value, ctx.params)
  if (isFamily(n, BOOLEAN_OPERATORS)) return booleanExpr(str, n.operator, ctx.params)
  if (isFamily(n, RELATIVE_OPERATORS)) {
    return relativeExpr(asDate(str), n.operator, n.value, ctx, true)
  }
  if (isFamily(n, SET_OPERATORS)) {
    // `t_has_num` carries an entry for EVERY trait key the person holds —
    // string and numeric alike (see `traitsCte`) — so it is the one map that
    // answers "does this person have this trait at all". `t_str` would report
    // a numeric trait as unset, and `t_num` a string one.
    return setExpr(`mapContains(t_has_num, ${key})`, n.operator)
  }

  const numeric =
    typeof n.value === 'number' || (Array.isArray(n.value) && typeof n.value[0] === 'number')
  if (!numeric) return compare(str, n.operator, n.value, 'String', ctx.params)

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

  if (isFamily(n, TEXT_OPERATORS)) return textExpr(column, n.operator, n.value, ctx.params)
  if (isFamily(n, SET_OPERATORS)) return setExpr(`${column} != ''`, n.operator)
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
  // `first_seen`/`last_seen` are non-nullable DateTime64 columns, so the
  // relative comparison is definite and needs no `ifNull` — unlike a trait,
  // whose date has to survive a parse first.
  if (isFamily(n, RELATIVE_OPERATORS)) {
    return relativeExpr(n.field, n.operator, n.value, ctx, false)
  }

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
 *
 * Comparison operators only, and that is a schema decision rather than a gap
 * here: what a behavioural leaf compares is a COUNT or a SUM, so `contains`,
 * `is set` and `in the last 7 days` have no reading on it. `Behavior` admits
 * `comparisonClause` alone, so there is no other family to dispatch.
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
