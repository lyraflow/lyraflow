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
import { escapeControlCharacters } from './control-chars.js'
import type { IngestPayload } from './payloads.js'
import { type PropertyValue, routeProperties } from './properties.js'
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

/** Every page view is stored under this name, named or not (#53). */
export const PAGE_EVENT_NAME = '$page'
/** ...and the name, when there is one, is a PROPERTY under this key. */
export const PAGE_NAME_PROPERTY = '$page_name'

/**
 * The stored `event_name` for a payload.
 *
 * EXPORTED, and that is the point of it. This logic used to exist twice --
 * here and as `payloadName` in the server's cardinality tracker -- with a
 * comment on each saying they had to move together. They did not have to; they
 * merely both happened to be right. Now there is one.
 *
 * `page(name)` used to store the NAME as the event name, which meant a page
 * view stopped being a page view and became its own event type. Three things
 * were wrong with that, and only the first is about naming:
 *
 * - There was no "all page views" query. `page('signup')` and
 *   `track('signup')` were indistinguishable once stored, and the `type`
 *   discriminator that could have told them apart was discarded right here.
 * - `event_name` is `LowCardinality(String)` and the second column of
 *   `event_schema`'s ORDER BY. Per-URL page names are unbounded by
 *   construction, which is the storage-level form of the same mistake.
 * - Every page name got its OWN per-event-name property-key budget in the
 *   cardinality tracker, rather than all page views sharing one.
 *
 * Events already stored under a page name stay that way: this changes ingest,
 * not history.
 */
export function eventNameFor(payload: IngestPayload): string {
  // Escaped here rather than in each renderer (#35). Only the `track` branch
  // can carry caller-chosen bytes -- the other two are our own literals -- but
  // the escape wraps the whole return so a future branch cannot reintroduce
  // the hole by forgetting it. `escapeControlCharacters` is identity on an
  // ordinary name, so this costs nothing for every legitimate event.
  if (payload.type === 'track') return escapeControlCharacters(payload.event)
  if (payload.type === 'page') return PAGE_EVENT_NAME
  return '$identify'
}

/**
 * The CALLER'S own property bag, before Lyraflow adds anything to it.
 *
 * Deliberately does not include `$page_name`, and the cardinality tracker
 * depends on that: `MAX_PROPERTIES_PER_EVENT` is the caller's budget, so a
 * `page('Pricing')` carrying exactly 250 properties must not be throttled
 * because the product added a 251st of its own.
 */
export function propertyBagFor(payload: IngestPayload): Record<string, PropertyValue> {
  return payload.type === 'identify' ? payload.traits : payload.properties
}

export function toEventRow(input: RowInput): EventRow {
  const { payload, now, projectId, trusted, geo, ua } = input
  const { properties, properties_num } = routeProperties(propertyBagFor(payload))
  const ctx = payload.context ?? {}

  // AFTER routing, which is what makes the `$` reservation structural rather
  // than a convention: `routeProperties` drops every caller-supplied key with
  // this prefix, so the only way one exists in a stored row is a write like
  // this one. A caller sending their own `$page_name` -- as a string or as a
  // number, which would otherwise land in the other map entirely -- cannot
  // collide with, shadow, or displace this.
  if (payload.type === 'page' && payload.name !== undefined) {
    properties[PAGE_NAME_PROPERTY] = payload.name
  }

  return {
    project_id: projectId,
    event_id: payload.message_id,
    anonymous_id: payload.anonymous_id ?? '',
    user_id: payload.user_id ?? '',
    event_name: eventNameFor(payload),
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
