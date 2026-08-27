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
 * Substring matching, and its negations. Case-INSENSITIVE, which is a
 * decision rather than an implementation detail: `path contains checkout`
 * missing `/Checkout` would be a wrong answer that looks like an empty
 * result, and every value these run against -- a URL, a referrer, a
 * campaign, a trait somebody typed -- is written by a human or a CMS rather
 * than normalised at ingest. `=` stays case-SENSITIVE, because changing it
 * would reinterpret every already-saved segment.
 *
 * The negations are their own operators rather than a `not` wrapper around
 * the positive form. A tree can already express that; what it cannot express
 * is the negation as ONE row of the editor, which is the shape an operator
 * reaches for.
 */
export const TEXT_OPERATORS = [
  'contains',
  'not_contains',
  'starts_with',
  'not_starts_with',
  'ends_with',
  'not_ends_with',
] as const
export type TextOperator = (typeof TEXT_OPERATORS)[number]

/**
 * Presence, which was previously UNASKABLE rather than merely unspelled
 * (#193).
 *
 * A ClickHouse `Map` returns the value type's DEFAULT for a key that is not
 * there, so `properties['plan']` is `''` both for a person with no `plan`
 * and for one whose `plan` is the empty string. No comparison operator can
 * separate those two, which is why this family compiles through
 * `mapContains` rather than through `compare` -- see `predicates.ts`.
 */
export const SET_OPERATORS = ['is_set', 'is_not_set'] as const
export type SetOperator = (typeof SET_OPERATORS)[number]

/**
 * Sugar over the stored text, exactly as #67 leaves it: ingest has no boolean
 * type and coerces one to `'true'`/`'false'` (`ingest/properties.ts`), so a
 * flag is filterable today only as `= "true"` -- correct, and reading like a
 * mistake. These compile to that same comparison; what they add is that the
 * editor and the summary say `is true`.
 *
 * Admitted on traits and properties ONLY. A context field or an event column
 * is a country, a path, a referrer -- never a flag -- and offering `is true`
 * there would be a control that silently matches nothing.
 */
export const BOOLEAN_OPERATORS = ['is_true', 'is_false'] as const
export type BooleanOperator = (typeof BOOLEAN_OPERATORS)[number]

/**
 * A relative date window, as words rather than as two timestamps the reader
 * has to compute.
 *
 * Resolved to an ABSOLUTE instant at compile time from the `now` the caller
 * threads in, exactly as `behaviour.ts`'s `windowStart` already resolves a
 * `last` window -- so the emitted SQL is deterministic given a `now`, and a
 * test can pin the instant rather than racing the clock.
 */
export const RELATIVE_OPERATORS = ['in_last', 'not_in_last'] as const
export type RelativeOperator = (typeof RELATIVE_OPERATORS)[number]

export type Operator =
  | ComparisonOperator
  | TextOperator
  | SetOperator
  | BooleanOperator
  | RelativeOperator

/** Every operator the AST accepts, in family order. */
export const ALL_OPERATORS = [
  ...COMPARISON_OPERATORS,
  ...TEXT_OPERATORS,
  ...SET_OPERATORS,
  ...BOOLEAN_OPERATORS,
  ...RELATIVE_OPERATORS,
] as const

/**
 * Which family an operator belongs to -- and therefore what its `value`
 * carries and which SQL builds it.
 *
 * An exhaustive `Record`, not a lookup with a fallback, for the reason
 * `OPERATOR_WORDS` in the UI's `vocabulary.ts` gives for the same shape: an
 * operator added to a family array and forgotten here must be a COMPILE
 * error, because the alternative is a `default:` branch quietly compiling it
 * as something else.
 */
export const OPERATOR_FAMILY: Record<
  Operator,
  'comparison' | 'text' | 'set' | 'boolean' | 'relative'
> = {
  '=': 'comparison',
  '!=': 'comparison',
  '>': 'comparison',
  '>=': 'comparison',
  '<': 'comparison',
  '<=': 'comparison',
  between: 'comparison',
  contains: 'text',
  not_contains: 'text',
  starts_with: 'text',
  not_starts_with: 'text',
  ends_with: 'text',
  not_ends_with: 'text',
  is_set: 'set',
  is_not_set: 'set',
  is_true: 'boolean',
  is_false: 'boolean',
  in_last: 'relative',
  not_in_last: 'relative',
}

/**
 * How many values a control must collect for an operator: two for `between`,
 * none for the presence and boolean families, one for everything else.
 *
 * Stated here rather than derived at each editor, because the editor, the
 * summariser and the schema all have to agree about it -- and the failure
 * when they do not is a row that renders a text box the server then rejects.
 */
export function operatorArity(op: Operator): 'none' | 'one' | 'two' | 'window' {
  const family = OPERATOR_FAMILY[op]
  if (family === 'set' || family === 'boolean') return 'none'
  if (family === 'relative') return 'window'
  return op === 'between' ? 'two' : 'one'
}

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
 * A predicate narrowed to its COMPARISON member -- the shape every predicate
 * had before the four new families (#193), and the one most fixtures still
 * build.
 *
 * Exported for the tests and editors that construct a predicate literally:
 * `{...node, value: 'x'}` over the whole union is an error now, because the
 * spread widens `operator` to every family and the relative member's value is
 * `{n, unit}`. Naming the member is clearer at each site than an assertion
 * that silences the check.
 */
export type Comparison<T> = Extract<T, { operator: ComparisonOperator }>

/**
 * `between` takes exactly two values; every other comparison operator takes
 * exactly one. Encoding that here rather than in the compiler means an
 * invalid tree is rejected at the API boundary with a field-level error,
 * instead of producing SQL with a dangling parameter.
 *
 * Generic over the VALUE schema because the two callers differ there and
 * nowhere else: a trait or a property may hold any scalar, while an event
 * column is `String`/`LowCardinality(String)` in `002_events.sql` and a
 * number there has no meaning that is not a lie -- it would either be
 * stringified in the compiler, silently comparing `5` against `'5'`, or
 * routed to a numeric map that has nothing to do with a column.
 */
function comparisonClause<V extends z.ZodTypeAny>(value: V) {
  return z
    .object({
      operator: z.enum(COMPARISON_OPERATORS),
      value: z.union([value, z.tuple([value, value])]),
    })
    .refine((v) => (v.operator === 'between') === Array.isArray(v.value), {
      message: '`between` requires exactly two values; other operators require one',
      path: ['value'],
    })
}

/**
 * A substring match. The needle is always a string, whatever the haystack is
 * declared to hold: `contains 5` on a numeric property is a category error,
 * not a shorthand, and admitting a number here would compile to a comparison
 * against the string `'5'` in the map that does not hold it.
 *
 * Capped at the same 512 the rest of this schema uses for free text, so a
 * predicate cannot carry a megabyte into a `position()` call over every row.
 */
const textClause = z.object({ operator: z.enum(TEXT_OPERATORS), value: z.string().max(512) })

/**
 * Presence and boolean clauses carry NO value at all.
 *
 * That is the change that makes this a union rather than a wider operator
 * enum: every clause the AST had before this point was `{operator, value}`,
 * and an `is_set` with a value slot would be a field every editor has to
 * render and every reader has to ignore. Zod strips an unknown `value` sent
 * alongside one of these rather than failing, which is the same tolerance
 * the rest of this schema shows for extra keys.
 */
const setClause = z.object({ operator: z.enum(SET_OPERATORS) })
const booleanClause = z.object({ operator: z.enum(BOOLEAN_OPERATORS) })

/**
 * The amount of time a relative window looks back.
 *
 * The SAME field definitions `Window`'s `last` variant uses -- spread into
 * both below rather than restated -- because #193 asks for relative dates in
 * "the vocabulary `Window` already has", and two independent copies of
 * `{n, unit}` would drift first at the 3650 cap.
 */
export const RelativeWindow = z.object({
  n: z.number().int().positive().max(3650),
  unit: z.enum(['hours', 'days']),
})
export type RelativeWindow = z.infer<typeof RelativeWindow>

const relativeClause = z.object({ operator: z.enum(RELATIVE_OPERATORS), value: RelativeWindow })

/**
 * The operators admitted on a TRAIT or a PROPERTY: all five families.
 *
 * These are the two targets whose value is arbitrary caller data of unknown
 * type, so every family means something -- a trait can hold a URL, a flag,
 * or an ISO date, and the tree cannot know which.
 */
const anyValueClause = z.union([
  comparisonClause(scalar),
  textClause,
  setClause,
  booleanClause,
  relativeClause,
])

/**
 * The operators admitted on a COLUMN -- an event column or a context field.
 *
 * No boolean and no relative-date family, and both exclusions are about the
 * column list rather than about the storage: every column either family
 * could name is a country, a device, a path, a referrer or a campaign. A
 * control offering `is true` on `latest_country` is one that matches nothing
 * and says nothing about why.
 *
 * `is_set` IS admitted, and means something different here than on a map: a
 * column always exists, so it compiles to an emptiness test rather than a
 * `mapContains`. See `predicates.ts`.
 */
function columnClause<V extends z.ZodTypeAny>(value: V) {
  return z.union([comparisonClause(value), textClause, setClause])
}

export const Window = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('last'), ...RelativeWindow.shape }),
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
  .and(anyValueClause)
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
 * Values are strings only -- see `columnClause`, which is also what admits
 * the text and presence families here while withholding the boolean and
 * relative-date ones.
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
  .and(columnClause(z.string()))
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
  .and(comparisonClause(scalar))
  .refine((b) => (b.aggregate === 'count') !== (b.property !== undefined), {
    message: '`count` takes no property; sum/min/max/distinct require one',
    path: ['property'],
  })
export type Behavior = z.infer<typeof Behavior>

export const Trait = z
  .object({ kind: z.literal('trait'), key: z.string().min(1).max(128) })
  .and(anyValueClause)
export type Trait = z.infer<typeof Trait>

export const Context = z
  .object({
    kind: z.literal('context'),
    field: z.enum(CONTEXT_FIELDS),
    scope: z.enum(['latest', 'first_touch']),
  })
  .and(columnClause(scalar))
export type Context = z.infer<typeof Context>

/**
 * Lifecycle bounds are instants, so every value must be a parseable datetime.
 * Enforced here rather than in the compiler because this is the API boundary:
 * a caller that sends "yesterday" gets a field-level rejection, instead of the
 * compiler calling `new Date` on it and formatting an Invalid Date into SQL.
 */
export const Lifecycle = z
  .object({ kind: z.literal('lifecycle'), field: z.enum(LIFECYCLE_FIELDS) })
  .and(z.union([comparisonClause(scalar), relativeClause]))
  .refine(
    (l) =>
      // A relative window carries `{n, unit}`, not an instant. Without this
      // guard the check below would run `String({n: 7, unit: 'days'})`,
      // get `[object Object]`, and reject every relative lifecycle bound --
      // the refine was written when `between` was the only two-slot shape.
      OPERATOR_FAMILY[l.operator] !== 'comparison' ||
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
