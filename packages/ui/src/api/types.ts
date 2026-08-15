/** `GET /v1/project` -- the identity fields the settings screen needs to build an install snippet. */
export interface ProjectIdentity {
  name: string
  slug: string
  write_key: string
}

/** `GET /v1/project/usage` -- this calendar month's counts against the project's quota. */
export interface Usage {
  month: string
  events_accepted: number
  events_rejected: number
  events_throttled: number
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
}

/**
 * `POST /v1/projects`'s response. `server_key` appears here and NOWHERE
 * else, ever -- only its SHA-256 is stored server-side, so this is the one
 * and only moment it can be captured. If the caller lets this value fall
 * out of memory without showing it, the person's only remedy is creating
 * another project and abandoning this one.
 */
export interface CreatedProject {
  name: string
  slug: string
  write_key: string
  server_key: string
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

export interface LyraEvent {
  event_id: string
  /** ISO 8601, already converted server-side. */
  timestamp: string
  event_name: string
  anonymous_id: string
  user_id: string
  properties: Record<string, string>
  properties_num: Record<string, number>
  url: string
  path: string
  referrer: string
  device_type: string
}

export interface EventsPage {
  events: LyraEvent[]
  next_cursor: string | null
}

export interface StatsBucket {
  bucket: string
  event_name?: string
  events: number
}
export interface StatsPage {
  buckets: StatsBucket[]
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
  event?: string
}
export interface StatsQuery {
  interval?: '1m' | '1h' | '1d'
  since?: string
  until?: string
}
export interface RejectionsQuery {
  limit?: number
  offset?: number
  since?: string
  until?: string
  reason?: string
}

/** One predicate on a step's own event properties. Authored only by the CLI --
 * the UI renders these read-only and refuses to re-save a step carrying them. */
export interface WherePredicate {
  property: string
  op: string
  value: unknown
}

export interface FunnelStep {
  event: string
  where?: WherePredicate[]
}

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
  created_at: string
  updated_at: string
}

export interface FunnelDefinition {
  steps: FunnelStep[]
  window_seconds: number
  segment_id?: number | null
}

export interface StepResult {
  index: number
  event: string
  people: number
  /** Server-computed. NEVER derive this from `from_start`. */
  from_previous: number
  /** Server-computed. NEVER derive this from a chain of `from_previous`. */
  from_start: number
}

export interface CostWarning {
  path: string
  reason: string
}

/** The body of `POST /v1/funnels/preview` and `POST /v1/funnels/:id/run`. */
export interface FunnelRunResult {
  entered: number
  converted: number
  conversion_rate: number
  steps: StepResult[]
  partial_window_entrants: number
  range: { since: string; until: string }
  as_of: string
  warnings: CostWarning[]
}

export interface RangeBody {
  since?: string
  until?: string
}

/** `GET /v1/segments`. Only the fields the picker needs; the route returns more. */
export interface Segment {
  id: number
  name: string
  /** True when the stored tree no longer parses. Such a segment is not selectable. */
  stale: boolean
}
