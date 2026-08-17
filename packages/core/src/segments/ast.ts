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
 * of its property maps.
 *
 * This exists because a `WherePredicate` compiles to `properties[<key>]` or
 * `properties_num[<key>]` and nothing else (`predicates.ts`'s
 * `wherePredicate`). A predicate naming one of these is therefore
 * well-formed, saveable, and reads an empty map slot: the value the operator
 * meant is a column two SELECTs away, and no error is ever raised. It is the
 * first thing a new operator writes — "page_view where path is /changelog" —
 * and the only signal they get is a zero.
 *
 * Spread from `CONTEXT_FIELDS` rather than restated, so this can never be a
 * subset of it: the same list that names a field as available to a `context`
 * condition names it as unavailable to a `where` predicate, and adding a
 * context field cannot leave this one behind.
 *
 * The extra four are the columns `ingest/payloads.ts` accepts into
 * `context` that no `context` CONDITION can read back — `path` and `url`
 * are stored per event and never folded into `device_index`, and the same
 * is true of the two UTM fields the device index does not keep. They are
 * exactly as unmatched by a `where` predicate as the ten above, so leaving
 * them out would have shipped a warning that misses the case that prompted
 * it. `packages/db`'s own test pins this whole list against the columns
 * `002_events.sql` actually declares, so a column added there fails a test
 * rather than quietly falling out of the list.
 *
 * NOT a validation rule, and deliberately not wired into any schema. A
 * property genuinely named `path` is possible — `properties` comes from the
 * caller's own bag and `path` from `context`, two disjoint sources — so a
 * predicate on one of these names may legitimately match. This list is what
 * a UI reads to SAY so at the point the name is typed; refusing the input
 * would be a guess dressed as a rule.
 */
export const EVENT_COLUMN_FIELDS = [
  ...CONTEXT_FIELDS,
  'path',
  'url',
  'utm_term',
  'utm_content',
] as const
export type EventColumnField = (typeof EVENT_COLUMN_FIELDS)[number]

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

/** Property predicates applied to the event before it is aggregated. */
export const WherePredicate = z
  .object({ property: z.string().min(1).max(128) })
  .and(valueFor(z.enum(COMPARISON_OPERATORS)))
export type WherePredicate = z.infer<typeof WherePredicate>

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
  .object({ kind: z.literal('lifecycle'), field: z.enum(['first_seen', 'last_seen']) })
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
