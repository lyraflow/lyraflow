import { newUuid } from './identity.js'
import type { Identity } from './identity.js'

export type EventType = 'track' | 'page' | 'identify'

export interface QueuedEvent {
  type: EventType
  message_id: string
  timestamp: string
  anonymous_id?: string
  user_id?: string
  context: Record<string, string>
  event?: string
  name?: string
  properties?: Record<string, unknown>
  traits?: Record<string, unknown>
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

export function pageContext(
  loc: Location = location,
  doc: Document = document,
  nav: Navigator = navigator,
): Record<string, string> {
  const ctx: Record<string, string> = {
    url: loc.href,
    path: loc.pathname,
    user_agent: nav.userAgent,
  }
  if (doc.referrer) ctx.referrer = doc.referrer
  const params = new URLSearchParams(loc.search)
  for (const key of UTM_KEYS) {
    const value = params.get(key)
    if (value) ctx[key] = value
  }
  return ctx
}

/**
 * Stamped at ENQUEUE, never at send. An event queued offline at 09:00 and
 * delivered at 09:40 must be dated 09:00 — and an unchanged timestamp across
 * retries is also what lets the storage engine collapse the duplicates.
 */
export function buildEvent(input: {
  type: EventType
  identity: Identity
  event?: string
  name?: string
  properties?: Record<string, unknown>
  traits?: Record<string, unknown>
  now?: Date
}): QueuedEvent {
  const e: QueuedEvent = {
    type: input.type,
    message_id: newUuid(),
    timestamp: (input.now ?? new Date()).toISOString(),
    anonymous_id: input.identity.anonymousId,
    context: pageContext(),
  }
  if (input.identity.userId) e.user_id = input.identity.userId
  if (input.event !== undefined) e.event = input.event
  if (input.name !== undefined) e.name = input.name
  if (input.properties) e.properties = input.properties
  if (input.traits) e.traits = input.traits
  return e
}
