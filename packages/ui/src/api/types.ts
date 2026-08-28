import type { FunnelDefinition, FunnelStep } from '@lyraflow/core/funnels/ast.js'
import type { FunnelResult, StepResult } from '@lyraflow/core/funnels/levels.js'

/**
 * `WherePredicate`, `FunnelStep`, `FunnelDefinition` and `StepResult` are
 * RE-EXPORTED from core, never declared again here.
 *
 * A hand-written copy of `WherePredicate` used to spell the operator field
 * `op`, while core -- and therefore the wire, and therefore every stored
 * funnel -- spells it `operator`. Nothing failed loudly: the field simply
 * read `undefined`, so a step's predicate rendered with a blank operator.
 * The compiler could not catch it, because the copy was internally
 * consistent; only the two declarations disagreed. The fix that cannot come
 * back is to stop having a second declaration at all.
 *
 * Both are TYPE-ONLY re-exports, erased at build time, so nothing about the
 * browser bundle changes -- the constraint `build-output.test.ts` guards
 * (core must stay free of node-only imports and import-time side effects)
 * applies to the runtime imports elsewhere in this package, not to these.
 *
 * `value` is core's scalar union (or a two-element tuple for `between`)
 * rather than `unknown`, so a control bound to it gets a compile error
 * instead of a cast.
 *
 * `Funnel` below is the one funnel shape still declared here, and that is not
 * an oversight: it is a STORED ROW -- id, timestamps, the cached run summary,
 * the `stale` flag -- and core has no such type to import, because core knows
 * about funnel definitions and results, not about rows. Composing it from
 * `FunnelDefinition` would also be wrong rather than merely awkward: that type
 * makes `segment_id` optional, while a row always carries the column. When a
 * canonical row type exists, this should import it.
 */
export type { WherePredicate } from '@lyraflow/core/segments/ast.js'
export type { FunnelDefinition, FunnelStep, StepResult }

/** `GET /v1/project` -- the identity fields the settings screen needs to build an install snippet. */
export interface ProjectIdentity {
  name: string
  slug: string
  write_key: string
}

/**
 * `GET /v1/meta` -- facts about the install itself rather than any one
 * project, which is why nothing here is project-scoped.
 */
export interface Meta {
  /** The release the running server was built from, e.g. `0.10.0`. */
  version: string
}

/** `GET /v1/project/usage` -- this calendar month's counts against the project's quota. */
export interface Usage {
  month: string
  events_accepted: number
  events_rejected: number
  events_throttled: number
  /**
   * Events dropped because the request looked like crawler traffic. Counted
   * apart from `events_rejected` (which means malformed): the two answer
   * different questions, and folding them together is what made "is my
   * integration broken, or is that just crawler traffic" unanswerable.
   */
  events_bot: number
  /** null means unlimited, and is what every project carries by default. */
  monthly_event_quota: number | null
}

export interface Project {
  id: number
  name: string
  slug: string
  created_at: string
  retention_months: number
  /** null means unlimited, and is what every project carries by default. */
  monthly_event_quota: number | null
  /**
   * When this project was archived, or `null` while it is active.
   *
   * Archived means ingest is refused and nothing else: every read still
   * works, retention still sweeps it, and restoring is one call. It is
   * deliberately not deletion -- see migration 018 for why deletion is a
   * separate, larger thing.
   */
  disabled_at: string | null
  /**
   * When this project's deletion was requested, or `null` before one ever
   * is. NOT `disabled_at`'s sibling in meaning: archived is reversible and
   * every read still works, while a deleting project is neither -- its
   * event and person data is torn down in both databases, there is no
   * restore, and `deleting_at` is stamped once and never cleared (migration
   * 019), so it stays set even if the teardown itself fails partway.
   */
  deleting_at: string | null
}

/** `PATCH /v1/projects/:id`. Both fields are optional independently: absent
 * means "leave alone", so a rename does not touch the archive state and an
 * archive does not touch the name. */
export interface ProjectUpdate {
  name?: string
  archived?: boolean
}

/**
 * `POST /v1/projects`'s response: every field of `Project` (#89 -- so a
 * caller can add the created row to an in-memory list, e.g. project
 * context's `projects`, without a second `GET /v1/projects` whose result
 * could race a concurrent edit and clobber it) plus the two one-time keys.
 * `server_key` appears here and NOWHERE else, ever -- only its SHA-256 is
 * stored server-side, so this is the one and only moment it can be
 * captured. If the caller lets this value fall out of memory without
 * showing it, the person's only remedy is creating another project and
 * abandoning this one.
 */
export interface CreatedProject extends Project {
  write_key: string
  server_key: string
}

/**
 * `GET /v1/project-deletions/:id` -- `:id` names the deletion request
 * (`deleteProject`'s own response `id`), not the project. `completed_at`
 * and `error` are both a CACHE of what the last poll saw, same discipline
 * as `Funnel`'s `last_evaluated_at`: `completed_at === null` while pending
 * or in progress, and `error` is set for a `failed` status, or for a
 * `pending` retry that has already failed once and will try again.
 */
export interface ProjectDeletion {
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  requested_at: string
  completed_at: string | null
  error?: string | null
}

/**
 * `PATCH /v1/project` body. Both fields are optional independently of one
 * another -- ABSENT means "leave unchanged", which is how retention is
 * edited without touching quota (and vice versa). `monthly_event_quota`
 * additionally distinguishes `null` (unlimited) from any number: sending
 * `0` is refused by the API with a 400, because `isOverQuota` throws on
 * it rather than treating it as a limit, and a throw on that path becomes
 * a 503 for every event of the project. Never coerce an empty input to
 * `0` when building this.
 */
export interface ProjectPatch {
  retention_months?: number
  monthly_event_quota?: number | null
}

/** `PATCH /v1/project`'s response -- the two fields it can change. */
export interface ProjectLimits {
  retention_months: number
  monthly_event_quota: number | null
}

/**
 * One row of `GET /v1/events`.
 *
 * Every field the route sends, not merely the four the feed table has
 * columns for. That route's `FeedRow` calls itself "a compile-time
 * allowlist" of the columns it selects, and it sends all of them; this
 * type used to stop after `device_type`, so the context an event carries
 * -- its campaign, its browser, where the visitor was -- was arriving on
 * the wire and being dropped on the floor before anything could show it.
 * A row's expanded detail is the one place in the product that answers
 * "what exactly did you receive", and it can only be as complete as this
 * declaration.
 *
 * All of the string fields are '' rather than absent when the event did
 * not carry them -- ClickHouse has no null here -- so a reader deciding
 * whether to render a field tests for the empty string, not for
 * `undefined`.
 */
export interface LyraEvent {
  event_id: string
  /** ISO 8601, already converted server-side. */
  timestamp: string
  event_name: string
  anonymous_id: string
  user_id: string
  /** Custom properties, split by type at ingest: strings here, numbers in
   * `properties_num`. One key never appears in both. */
  properties: Record<string, string>
  properties_num: Record<string, number>
  url: string
  path: string
  referrer: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_term: string
  utm_content: string
  device_type: string
  os: string
  browser: string
  country: string
  region: string
  city: string
}

export interface EventsPage {
  events: LyraEvent[]
  next_cursor: string | null
  /**
   * Built from the page's FIRST (oldest) row, the same way `next_cursor` is
   * built from its last (newest) one -- present on every response regardless
   * of which direction produced it. Paired with `next_cursor` this lets a
   * caller that opened on a `before` walk keep walking backwards, or turn
   * around and walk forwards again, without re-deriving a cursor from row
   * data itself.
   */
  prev_cursor: string | null
}

export interface StatsBucket {
  bucket: string
  /** Present only for `group_by=event_name`, kept for pre-trends callers. */
  event_name?: string
  /** The breakdown value. Absent when nothing was grouped. */
  series?: string
  events: number
}
export interface StatsPage {
  buckets: StatsBucket[]
  /** How many series the server folded into `(other)`. Absent when ungrouped. */
  folded_series?: number
}

export interface Rejection {
  received_at: string
  reason: string
  detail: string
  payload: string
}
export interface RejectionsPage {
  rejections: Rejection[]
  has_more: boolean
  next_offset: number
}

export interface EventsQuery {
  limit?: number
  since?: string
  until?: string
  after?: string
  /**
   * The backwards half of the keyset walk. Mutually exclusive with `after`
   * -- the server 400s `invalid_query` if both are sent, rather than
   * picking a winner.
   */
  before?: string
  event?: string
  /**
   * A user id, anonymous id or device id -- narrows the feed to one
   * person's own events, resolved server-side the same way `GET
   * /v1/persons/:id` resolves its own path parameter
   * (`identity/scope.ts`'s `resolvePersonScope`). The feed screen never
   * sets this; `people/Timeline.tsx` (Task 7) is the first caller, walking
   * one person's history rather than the project's.
   */
  person?: string
}
export interface StatsQuery {
  interval?: '1m' | '1h' | '1d' | '1w'
  since?: string
  until?: string
  /** One event name. The same field `EventsQuery` carries, because the feed
   * draws this aggregate directly above the table that query fills and a
   * filter reaching only one of them would put two different questions on
   * one screen. */
  event?: string
  /**
   * `event_name`, `attribute:<column>` or `property:<key>`.
   *
   * A string rather than a union, because the `property:` half carries a
   * caller-supplied key no union can enumerate. `screens/trends/params.ts`
   * builds it; the server refuses anything it does not recognise rather than
   * ignoring it.
   */
  group_by?: string
}
export interface RejectionsQuery {
  limit?: number
  offset?: number
  since?: string
  until?: string
  reason?: string
}

/** One predicate on a step's own event properties, and the step that carries
 * them -- both re-exported (at the top of this file) from core rather than
 * declared again here. See that re-export for why. */

/** `GET /v1/funnels` and `GET /v1/funnels/:id`.
 *
 * `last_entered` / `last_converted` / `last_evaluated_at` are a CACHE, not a
 * fact: the server writes them after each run and never recomputes them. A
 * rate derived from them must always render beside `last_evaluated_at`, and a
 * funnel with `last_evaluated_at === null` has never been run -- which is a
 * different fact from a 0% conversion and must not render as one.
 *
 * `stale` is true when the stored `steps` no longer parse. Always present,
 * `false` for ordinary rows, so one field is checked regardless of route. */
export interface Funnel {
  id: number
  name: string
  definition_version: number
  steps: FunnelStep[]
  window_seconds: number
  segment_id: number | null
  stale: boolean
  last_entered: number | null
  last_converted: number | null
  last_evaluated_at: string | null
  /**
   * The window the cached counts were computed over (#91). `null` for a funnel
   * that has never run, and for one summarised before the range was recorded
   * at all -- in which case the rate is real but the question it answers is
   * unknown, and must not be rendered as though it were the list's default.
   */
  last_range: { since: string; until: string } | null
  created_at: string
  updated_at: string
}

export interface CostWarning {
  path: string
  reason: string
}

/**
 * The body of `POST /v1/funnels/preview` and `POST /v1/funnels/:id/run`.
 *
 * EXTENDS core's `FunnelResult` rather than restating its five fields. Those
 * are what the engine computes; the three below are what the HTTP layer adds
 * about the request that produced them. Redeclaring the first five is how the
 * UI and the engine drift apart while both remain internally coherent -- which
 * is exactly what happened to a step's predicate field name (#117), where each
 * declaration was correct on its own terms so nothing disagreed for the
 * compiler to catch.
 */
export interface FunnelRunResult extends FunnelResult {
  range: { since: string; until: string }
  as_of: string
  warnings: CostWarning[]
}

/**
 * A run's range, stated one of two ways and never both -- the server refuses
 * a body carrying `days` alongside either absolute bound rather than picking
 * a winner.
 *
 * Prefer `days` for a relative range. `since` alone cannot express one
 * correctly: `until` then defaults to the SERVER's clock while `since` came
 * from this one, and the resulting span is longer than the client asked for
 * by however long the request took to arrive. At the 90-day maximum that
 * overshoot is the difference between the largest legal range and a 400.
 */
export interface RangeBody {
  days?: number
  since?: string
  until?: string
}

/**
 * `POST /v1/funnels/:id/people`'s request body. `mode` has no default,
 * matching the server -- `reached` (level >= step) and `dropped` (level =
 * step) differ by a large factor on a real funnel, and whichever default
 * was picked, the other reading is the one a caller would get by accident.
 *
 * `skipped` is optional steps only, and the two others are refused on one:
 * the server 400s rather than answering a neighbouring question.
 */
export interface FunnelPeopleQuery {
  step: number
  mode: 'reached' | 'dropped' | 'skipped'
  since?: string
  until?: string
  cursor?: string
}

/**
 * `POST /v1/funnels/:id/people`'s response. Same walk shape as segments'
 * `MemberPage` (`screens/segments/MemberList.tsx`) -- `members`,
 * `next_cursor`, `window_exhausted`, `person_count` -- which is what lets
 * `MemberList` be reused unchanged for a funnel step's people. `as_of` and
 * `range` are extra: the segment route has no equivalent because it has no
 * `since`/`until` to resolve, but this one does, the same way a funnel run
 * does.
 */
export interface FunnelPeoplePage {
  members: MemberRow[]
  next_cursor: string | null
  window_exhausted: boolean
  person_count: number
  as_of: string
  range: { since: string; until: string }
}

/** `GET /v1/segments` and `GET /v1/segments/:id`.
 *
 * `last_count` and `last_evaluated_at` are a CACHE, not a fact -- written
 * after an evaluation and never recomputed. A count must always render beside
 * its timestamp, and `last_evaluated_at === null` means never evaluated, which
 * is a different fact from a count of zero.
 *
 * `stale` is true when the stored tree no longer parses. Always present. */
export interface Segment {
  id: number
  name: string
  ast_version: number
  filter: unknown
  stale: boolean
  last_count: number | null
  last_evaluated_at: string | null
  created_at: string
  updated_at: string
}

/**
 * One row of a segment's member preview.
 *
 * The named fields are what `memberProjection` (core, `segments/compile.ts`)
 * always selects; the index signature is the ten `CONTEXT_FIELDS` values it
 * also selects, which have no fixed names here. Both record types appear in
 * the signature only because TypeScript requires it to cover every named
 * member above it.
 *
 * `traits`/`traits_num` are split by type because `person_traits` stores them
 * that way -- one key is never in both -- and are capped per person, which is
 * what `trait_total` exists to report: it is the person's real trait count,
 * so a reader can be told what was held back rather than shown a truncated
 * list that looks complete.
 */
export interface MemberRow {
  person_id: string
  first_seen: string
  last_seen: string
  /** True the instant any of this person's device-index rows carried a real
   * `user_id` -- i.e. they were ever `identify()`d, rather than resolved
   * purely through the device fallback (core's `base.ts`, the `base` CTE).
   * `person_id` alone cannot tell the two apart, which is the whole reason
   * this field exists: `MemberList` uses it the same way the feed's
   * `AcceptedTable` uses `event.user_id` -- to mark which rows lead to a
   * real profile, per #18. */
  identified: boolean
  traits: Record<string, string>
  traits_num: Record<string, number>
  trait_total: number
  [field: string]: string | number | boolean | Record<string, string> | Record<string, number>
}

/** Both preview routes. `members`, `next_cursor` and `window_exhausted` are
 * present only when members were requested.
 *
 * The two endings of a walk are distinguished by these two fields together:
 * `next_cursor: null` with `window_exhausted: false` means the population is
 * exhausted; with `true` it means the walk's budget is spent and more exist. */
export interface SegmentPreview {
  person_count: number
  warnings: { path: string; reason: string }[]
  as_of: string
  members?: MemberRow[]
  next_cursor?: string | null
  window_exhausted?: boolean
}

export interface PreviewOptions {
  include?: ['members']
  cursor?: string
}

/**
 * Which of the two property maps a name's values live in, as `event_schema`
 * recorded them.
 *
 * This is not a formality. Ingest routes a finite number to `properties_num`
 * and everything else to `properties` (`routeProperties`, core), and a
 * predicate reads ONE of those two maps -- chosen from the JavaScript type of
 * its value. A builder that cannot produce a number therefore writes
 * predicates that read the wrong map and match nothing, which is what this
 * type exists to prevent.
 *
 * `mixed` is a real answer, not a missing one: a project that has sent the
 * same key both ways has both rows in `event_schema`, and no single predicate
 * can read both maps.
 */
export type PropertyKind = 'string' | 'number' | 'mixed'

export interface SchemaProperty {
  name: string
  kind: PropertyKind
}

/**
 * One cohort's row of a retention grid. `retained[k]` is how many of `size`
 * came back in period `k`, or `null` when that period had not finished when
 * the grid was computed.
 *
 * `number | null`, not `number`. Collapsing the two is how a retention grid
 * reports "these weeks have not happened yet" as "nobody came back", which
 * is a cliff in exactly the corner a reader looks at for a trend.
 */
export interface CohortRow {
  cohort: string
  size: number
  retained: (number | null)[]
}

export interface RetentionResult {
  granularity: 'day' | 'week' | 'month'
  periods: number
  cohorts: CohortRow[]
  start_event: string
  return_event: string
  since: string
  until: string
  /** When measurability was decided; a `null` cell is only "not yet" as of this. */
  computed_at: string
  warnings: { path: string; reason: string }[]
}

export interface RetentionRequest {
  start_event: string
  return_event: string
  /** Which occurrence of each event counts. The segment/funnel `where`
   * grammar verbatim -- typed as `unknown[]` here only because this module
   * describes the wire and does not import core's schema. */
  start_where?: unknown[]
  return_where?: unknown[]
  granularity: 'day' | 'week' | 'month'
  periods: number
  since?: string
  until?: string
  segment_id?: number | null
}

/**
 * A trend is a `StatsPage` -- the SAME response the feed's chart reads, with
 * a `series` field on each bucket. Aliased rather than redeclared: two shapes
 * for one endpoint is how the feed and this screen would come to disagree
 * about what the server returns.
 */
export type TrendPoint = StatsBucket
export type TrendResult = StatsPage

/**
 * `GET /v1/persons/:id`.
 *
 * `ids` is every id this person owns -- their group of user ids and device
 * ids together, deduped and sorted -- and `devices` is the subset of those
 * that are device ids. `ids` alone cannot tell the two groups apart, which
 * is why both travel: the identity header renders them apart, and needs
 * `devices` to know which of `ids` to label which way.
 *
 * `traits_withheld` is true exactly when a deletion boundary exists for
 * this person. Under it, `traits` and `traits_num` are both `{}` and
 * `trait_total` is `0` -- but that is NOT the same fact as "this person has
 * no traits", and a screen rendering these two cases must say different
 * things for them. A trait carries no timestamp (the `argMax` states in
 * `004_person_traits.sql` discard it), so unlike an event it cannot be
 * split at a boundary -- the whole trait set is withheld or none of it is.
 *
 * `trait_total` is what the person HAS, which may exceed what `traits` /
 * `traits_num` actually carry: both maps are capped at 50 entries, same
 * discipline as `MemberRow`'s field of the same name.
 */
export interface Person {
  person_id: string
  /** Every id this person owns: user ids and device ids together. */
  ids: string[]
  /** The device ids among them -- a subset of `ids`. The identity header
   * renders the two groups apart; `ids` alone cannot tell them apart. */
  devices: string[]
  first_seen: string
  last_seen: string
  events: number
  traits: Record<string, string>
  traits_num: Record<string, number>
  trait_total: number
  /** True when a deletion boundary exists. `traits` is then empty because a
   * trait carries no timestamp and cannot be split at one -- NOT because
   * the person has none. */
  traits_withheld: boolean
}

/** `DELETE /v1/persons/:id`'s 202 response. `request_id` is the id
 * `deletion()` below polls by -- not the person's own id, which travels
 * separately as `person_id`. */
export interface PersonDeletion {
  request_id: number
  person_id: string
  suppressed_at: string
}

/**
 * `GET /v1/deletions/:id`. Same cache discipline as `ProjectDeletion`:
 * `completed_at` is `null` while pending or in progress, and `error` is set
 * for a `failed` status, or for a `pending` retry that has already failed
 * once and will try again.
 */
export interface DeletionStatus {
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  requested_at: string
  completed_at: string | null
  error?: string | null
}
