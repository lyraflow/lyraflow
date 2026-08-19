/**
 * Builds the ClickHouse row an ingested event becomes.
 *
 * In core rather than the server because it is PURE -- payload in, row out,
 * no server state -- and because the CLI's demo seeder needs exactly this one
 * function. It used to reach it through `@lyraflow/server`, which meant
 * installing the CLI pulled in Fastify and the whole ingest and query surface
 * to compose a handful of fields (#125).
 *
 * Avoiding a second implementation was always the right call: a duplicated
 * notion of "what an event row looks like" drifts, and then demo data stops
 * resembling production data, which is the only reason the seeder exists. This
 * keeps the single implementation and drops the dependency.
 */
import type { UserAgentInfo } from '../enrich/user-agent.js'
import type { IngestPayload } from './payloads.js'
import { routeProperties } from './properties.js'
import { clampTimestamp } from './timestamp.js'

/**
 * The geo fields an event carries. The SHAPE lives here with the row it is a
 * part of; resolving it -- which needs a database and a request IP -- stays in
 * the server (#125).
 */
export interface GeoInfo {
  country: string
  region: string
  city: string
}

export interface EventRow {
  project_id: number
  event_id: string
  anonymous_id: string
  user_id: string
  event_name: string
  timestamp: string
  received_at: string
  trusted: 0 | 1
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

export interface RowInput {
  projectId: number
  payload: IngestPayload
  now: Date
  trusted: boolean
  geo: GeoInfo
  ua: UserAgentInfo
}

/** ClickHouse DateTime64(3) wants 'YYYY-MM-DD HH:MM:SS.mmm', not ISO-8601. */
export function chDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * Inverse of chDateTime. Used to recover the event's own (clamped) instant
 * from an already-built EventRow — e.g. to bind identity at the moment the
 * event happened rather than the moment it was processed. See
 * `registerIngestRoutes`'s identify handling for why that distinction
 * matters for a late-delivered event.
 */
export function parseChDateTime(s: string): Date {
  return new Date(`${s.replace(' ', 'T')}Z`)
}

function eventName(payload: IngestPayload): string {
  if (payload.type === 'track') return payload.event
  if (payload.type === 'page') return payload.name ?? '$page'
  return '$identify'
}

export function toEventRow(input: RowInput): EventRow {
  const { payload, now, projectId, trusted, geo, ua } = input
  const bag = payload.type === 'identify' ? payload.traits : payload.properties
  const { properties, properties_num } = routeProperties(bag)
  const ctx = payload.context ?? {}

  return {
    project_id: projectId,
    event_id: payload.message_id,
    anonymous_id: payload.anonymous_id ?? '',
    user_id: payload.user_id ?? '',
    event_name: eventName(payload),
    timestamp: chDateTime(clampTimestamp(payload.timestamp, now)),
    received_at: chDateTime(now),
    trusted: trusted ? 1 : 0,
    properties,
    properties_num,
    url: ctx.url ?? '',
    path: ctx.path ?? '',
    referrer: ctx.referrer ?? '',
    utm_source: ctx.utm_source ?? '',
    utm_medium: ctx.utm_medium ?? '',
    utm_campaign: ctx.utm_campaign ?? '',
    utm_term: ctx.utm_term ?? '',
    utm_content: ctx.utm_content ?? '',
    device_type: ua.device_type,
    os: ua.os,
    browser: ua.browser,
    country: geo.country,
    region: geo.region,
    city: geo.city,
  }
}
