import { z } from 'zod'

/**
 * Bumped whenever a change would make an already-saved tree parse
 * differently — or stop parsing. Saved segments carry the version they were
 * written with, so a future reader can migrate them instead of silently
 * misinterpreting them.
 */
export const AST_VERSION = 1

export const COMPARISON_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'between'] as const
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number]

/**
 * Context fields are COLUMN NAMES in the compiled SQL, and a column name
 * cannot be a bound parameter. This allowlist is therefore an injection
 * boundary, not a convenience: it is the only thing standing between request
 * data and a bare SQL identifier. Every entry maps to a real device_index
 * column in base.ts's CONTEXT_COLUMNS, and that mapping is asserted in a
 * test so the two cannot drift.
 */
export const CONTEXT_FIELDS = [
  'country',
  'region',
  'city',
  'device_type',
  'os',
  'browser',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
] as const
export type ContextField = (typeof CONTEXT_FIELDS)[number]

/**
 * Every name that is a COLUMN on the events table rather than a key in one
 * of its property maps — and, since attribute predicates exist, exactly the
 * set an `AttributePredicate` may name.
 *
 * It began as a WARNING list. A `WherePredicate` compiled to
 * `properties[<key>]` and nothing else, so a predicate on `path` was
 * well-formed, saveable, and read an empty map slot: the value the operator
 * meant was a column two SELECTs away, and no error was ever raised. "page
 * view where path is /changelog" is the first thing a new operator writes
 * and the only signal they got was a zero. The list existed so a UI could
 * say so; it now names what the grammar can actually read.
 *
 * That promotion is why it is ALSO an injection boundary. `AttributePredicate`
 * types its field as `z.enum` over this array, and `predicates.ts`
 * interpolates the result as a bare SQL identifier — the same arrangement
 * `CONTEXT_FIELDS` has with `contextExpr`. Every entry must be a real column
 * on `events`, and `packages/db`'s own test pins this whole list against the
 * columns `002_events.sql` declares, so a column renamed there fails a test
 * rather than reaching SQL as a name nothing defines.
 *
 * Spread from `CONTEXT_FIELDS` rather than restated, so this can never be a
 * subset of it: a field readable by a `context` condition is readable by a
 * `where` predicate too, and adding a context field cannot leave this one
 * behind.
 *
 * The extra four are the columns `ingest/payloads.ts` accepts into `context`
 * that no `context` CONDITION can read back — `path` and `url` are stored
 * per event and never folded into `device_index`, and the same is true of
 * the two UTM fields the device index does not keep. They are the four with
 * no other route to an operator at all, which is why leaving them out was
 * never on the table.
 *
 * STILL not a rule about property names. A property genuinely named `path`
 * is possible — `properties` comes from the caller's own bag and `path` from
 * `context`, two disjoint sources — and stays reachable through a
 * `PropertyPredicate`. Which of the two a predicate means is stated by
 * `source`, never inferred from the name.
 */
export const EVENT_COLUMN_FIELDS = [
  ...CONTEXT_FIELDS,
  'path',
  'url',
  'utm_term',
  'utm_content',
] as const
export type EventColumnField = (typeof EVENT_COLUMN_FIELDS)[number]

/**
 * The two per-person timestamps a `lifecycle` condition can bound.
 *
 * Exported and named for the same reason `CONTEXT_FIELDS` is, and it is not
 * tidiness: `predicates.ts`'s `lifecycleExpr` interpolates a lifecycle node's
 * `field` DIRECTLY AS A BARE SQL IDENTIFIER into the generated WHERE clause.
 * The value is bounded, so nothing arbitrary reaches SQL -- but what bounds it
 * has to be the same list everything else reads, or the boundary is closed by
 * two copies agreeing rather than by construction.
 *
 * Before this constant existed the enum below was written out inline and the
 * web UI's lifecycle form declared its own matching pair. Both were correct.
 * Neither could see the other drift: TypeScript cannot compare a literal here
 * against a literal in a `.tsx` file two packages away, so a third field added
 * to one and not the other would have compiled, shipped, and reached the
 * identifier interpolation before anything noticed.
 *
 * Both names below the fold now derive from this array -- the schema through
 * `z.enum(LIFECYCLE_FIELDS)`, the UI's select by mapping over it -- so adding a
 * field is one edit and removing one is a compile error at every reader.
 *
 * The remaining thing that CAN drift is this list against the columns the base
 * CTE actually produces, since `base.ts` builds `first_seen` and `last_seen`
 * into its SQL text rather than from any list. `ast.test.ts` pins that
 * directly: every entry here must appear as a selected alias in `baseCte`'s
 * output. A field named here and absent there would compile to a WHERE clause
 * referencing a column that does not exist.
 */
export const LIFECYCLE_FIELDS = ['first_seen', 'last_seen'] as const
export type LifecycleField = (typeof LIFECYCLE_FIELDS)[number]

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * `between` takes exactly two values; every other operator takes exactly one.
 * Encoding that here rather than in the compiler means an invalid tree is
 * rejected at the API boundary with a field-level error, instead of producing
 * SQL with a dangling parameter.
 */
function valueFor<T extends z.ZodTypeAny>(operator: T) {
  return z
    .object({ operator, value: z.union([scalar, z.tuple([scalar, scalar])]) })
    .refine((v) => (v.operator === 'between') === Array.isArray(v.value), {
      message: '`between` requires exactly two values; other operators require one',
      path: ['value'],
    })
}

/**
 * `valueFor`, restricted to string values.
 *
 * Every column an `AttributePredicate` can name is `String` or
 * `LowCardinality(String)` in `002_events.sql`, so a number there has no
 * meaning that is not a lie: it would either be stringified in the compiler,
 * silently comparing `5` against `'5'`, or routed to a numeric map that has
 * nothing to do with a column. Refusing it at the API boundary is the same
 * bargain `valueFor`'s own `between` refinement makes -- a field-level error
 * now, rather than SQL that runs and answers wrongly.
 *
 * A separate helper rather than a parameter on `valueFor`, because that one
 * is generic over the OPERATOR schema and its value union is fixed; both
 * callers read better with the difference in the name.
 */
function valueForString<T extends z.ZodTypeAny>(operator: T) {
  return z
    .object({ operator, value: z.union([z.string(), z.tuple([z.string(), z.string()])]) })
    .refine((v) => (v.operator === 'between') === Array.isArray(v.value), {
      message: '`between` requires exactly two values; other operators require one',
      path: ['value'],
    })
}

export const Window = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('last'),
    n: z.number().int().positive().max(3650),
    unit: z.enum(['hours', 'days']),
  }),
  z.object({ kind: z.literal('absolute'), from: z.string().datetime(), to: z.string().datetime() }),
  z.object({ kind: z.literal('ever') }),
])
export type Window = z.infer<typeof Window>

export const AGGREGATES = ['count', 'sum', 'min', 'max', 'distinct'] as const
export type Aggregate = (typeof AGGREGATES)[number]

/**
 * A predicate on a key in the event's own property bag -- what a caller put
 * in `properties` when they sent it.
 *
 * `source` is OPTIONAL and, when present, can only be `'property'`. That is
 * what keeps every tree saved before attribute predicates existed parsing
 * exactly as it always did: such a tree carries `property` and no `source`,
 * matches this member, and compiles byte-identically. Nothing is migrated
 * and nothing is reinterpreted, which is the bar `AST_VERSION`'s own comment
 * sets for leaving the version alone.
 */
export const PropertyPredicate = z
  .object({
    property: z.string().min(1).max(128),
    source: z.literal('property').optional(),
  })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
export type PropertyPredicate = z.infer<typeof PropertyPredicate>

/**
 * A predicate on a COLUMN of the event -- its path, its campaign, the device
 * it came from -- rather than on a key in its property bag.
 *
 * `attribute` is a `z.enum` over `EVENT_COLUMN_FIELDS` and that is the whole
 * design, not a formality. `predicates.ts` interpolates it as a BARE SQL
 * IDENTIFIER, exactly as `contextExpr` does with a context field, and that
 * is safe for exactly the same reason: the value reaching the compiler is
 * typed `EventColumnField`, so there is no runtime check anywhere that a
 * later edit could forget. A flag beside a free-typed string would have put
 * the allowlist back into the compiler's hands.
 *
 * Values are strings only -- see `valueForString`.
 *
 * NOT inferred from the name, ever. A property genuinely named `path` is
 * possible and keeps working: `properties` comes from the caller's own bag
 * and `path` from `context`, two disjoint sources. Which one a predicate
 * means is stated by `source`, never guessed from what the name looks like.
 */
export const AttributePredicate = z
  .object({
    source: z.literal('attribute'),
    attribute: z.enum(EVENT_COLUMN_FIELDS),
  })
  .and(valueForString(z.enum(COMPARISON_OPERATORS)))
export type AttributePredicate = z.infer<typeof AttributePredicate>

/**
 * Property predicates and attribute predicates applied to the event before
 * it is aggregated, in ONE array.
 *
 * One list rather than two, because they mean one thing -- constraints on
 * the event that matched, ANDed together. Two arrays would split
 * `MAX_WHERE_PREDICATES`, double the editor, and hand an operator two
 * controls with identical meaning.
 *
 * A plain union, not `discriminatedUnion`: the discriminator is absent on
 * every already-saved property predicate, and Zod's discriminated union
 * needs the key present before it can choose. Order matters only in that
 * both members are unambiguous -- a property predicate has `property` and
 * either no `source` or `'property'`; an attribute predicate has `source:
 * 'attribute'` and `attribute`.
 */
export const WherePredicate = z.union([PropertyPredicate, AttributePredicate])
export type WherePredicate = z.infer<typeof WherePredicate>

/**
 * The field one `where` predicate names, and which of the two places it is
 * read from.
 *
 * ONE spelling of the discrimination, for every consumer that needs the name
 * without needing the SQL: the funnel store's definition equality, the
 * summariser that renders a saved segment as a sentence, and the editor row.
 * Each of those had to know that a predicate has either `property` or
 * `attribute`, and three copies of `w.source === 'attribute' ? … : …` is how
 * a fourth shape added later gets handled in two of them.
 */
export function wherePredicateField(w: WherePredicate): {
  source: 'property' | 'attribute'
  name: string
} {
  return w.source === 'attribute'
    ? { source: 'attribute', name: w.attribute }
    : { source: 'property', name: w.property }
}

/**
 * How many predicates one event may carry — a behaviour's, or a funnel
 * step's. Named rather than repeated as a bare `10` at each `where` array:
 * an editor that disables its own "add" control has to know the same number
 * the schema rejects on, and two literals a package apart drift into a form
 * that lets an operator build a step the server then refuses.
 */
export const MAX_WHERE_PREDICATES = 10

export const Behavior = z
  .object({
    kind: z.literal('behavior'),
    /** An event name, or '*' for any event. */
    event: z.string().min(1).max(128),
    where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
    aggregate: z.enum(AGGREGATES),
    property: z.string().min(1).max(128).optional(),
    window: Window,
  })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
  .refine((b) => (b.aggregate === 'count') !== (b.property !== undefined), {
    message: '`count` takes no property; sum/min/max/distinct require one',
    path: ['property'],
  })
export type Behavior = z.infer<typeof Behavior>

export const Trait = z
  .object({ kind: z.literal('trait'), key: z.string().min(1).max(128) })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
export type Trait = z.infer<typeof Trait>

export const Context = z
  .object({
    kind: z.literal('context'),
    field: z.enum(CONTEXT_FIELDS),
    scope: z.enum(['latest', 'first_touch']),
  })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
export type Context = z.infer<typeof Context>

/**
 * Lifecycle bounds are instants, so every value must be a parseable datetime.
 * Enforced here rather than in the compiler because this is the API boundary:
 * a caller that sends "yesterday" gets a field-level rejection, instead of the
 * compiler calling `new Date` on it and formatting an Invalid Date into SQL.
 */
export const Lifecycle = z
  .object({ kind: z.literal('lifecycle'), field: z.enum(LIFECYCLE_FIELDS) })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
  .refine(
    (l) =>
      (Array.isArray(l.value) ? l.value : [l.value]).every(
        (v) => v !== null && !Number.isNaN(new Date(String(v)).getTime()),
      ),
    { message: 'lifecycle values must be datetimes', path: ['value'] },
  )
export type Lifecycle = z.infer<typeof Lifecycle>

export type Group = { kind: 'group'; op: 'and' | 'or'; children: FilterNode[] }
export type Not = { kind: 'not'; child: FilterNode }
export type FilterNode = Group | Not | Trait | Context | Lifecycle | Behavior

/**
 * Recursive, so the type has to be declared before the schema and tied
 * together with z.lazy. `children` is capped at 50 here and the WHOLE tree is
 * capped again in validate.ts — this bound stops a single absurd level, the
 * other stops a deep one, and neither subsumes the other.
 */
export const FilterNode: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('group'),
      op: z.enum(['and', 'or']),
      children: z.array(FilterNode).min(1).max(50),
    }),
    z.object({ kind: z.literal('not'), child: FilterNode }),
    Trait,
    Context,
    Lifecycle,
    Behavior,
  ]),
)

export const SegmentQuery = z.object({
  ast_version: z.literal(AST_VERSION),
  filter: FilterNode,
})
export type SegmentQuery = z.infer<typeof SegmentQuery>
