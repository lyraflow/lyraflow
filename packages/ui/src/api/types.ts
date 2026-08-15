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
