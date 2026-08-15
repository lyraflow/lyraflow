export interface Project {
  id: number
  name: string
  slug: string
  created_at: string
  retention_months: number
  /** null means unlimited, and is what every project carries by default. */
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
