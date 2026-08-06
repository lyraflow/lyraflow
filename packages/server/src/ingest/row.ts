import { type IngestPayload, clampTimestamp, routeProperties } from '@lyraflow/core'
import type { UserAgentInfo } from '@lyraflow/core'
import type { GeoInfo } from './geo.js'

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
function chDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
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
