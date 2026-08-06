import type { IngestPayload } from '@lyraflow/core'

export const MAX_PROPERTIES_PER_EVENT = 250
export const MAX_EVENT_NAMES_PER_PROJECT = 1000
export const MAX_PROPERTY_KEYS_PER_EVENT_NAME = 500

export type LimitReason =
  | 'too_many_properties'
  | 'event_name_cardinality'
  | 'property_key_cardinality'

export type LimitResult = { ok: true } | { ok: false; reason: LimitReason; detail: string }

/**
 * In-memory view of observed cardinality, rebuilt from event_schema on boot.
 *
 * Uncapped cardinality is the quiet failure mode of a public write endpoint:
 * unbounded distinct event names destroy the LowCardinality encoding on the
 * events table and bloat event_schema until autocomplete is useless.
 */
export class CardinalityTracker {
  #eventNames = new Map<number, Set<string>>()
  #propertyKeys = new Map<string, Set<string>>()

  observe(projectId: number, eventName: string, keys: string[]): void {
    let names = this.#eventNames.get(projectId)
    if (!names) {
      names = new Set()
      this.#eventNames.set(projectId, names)
    }
    names.add(eventName)

    const mapKey = `${projectId}:${eventName}`
    let props = this.#propertyKeys.get(mapKey)
    if (!props) {
      props = new Set()
      this.#propertyKeys.set(mapKey, props)
    }
    for (const k of keys) props.add(k)
  }

  knowsEventName(projectId: number, eventName: string): boolean {
    return this.#eventNames.get(projectId)?.has(eventName) ?? false
  }

  eventNameCount(projectId: number): number {
    return this.#eventNames.get(projectId)?.size ?? 0
  }

  propertyKeyCount(projectId: number, eventName: string): number {
    return this.#propertyKeys.get(`${projectId}:${eventName}`)?.size ?? 0
  }

  knowsPropertyKey(projectId: number, eventName: string, key: string): boolean {
    return this.#propertyKeys.get(`${projectId}:${eventName}`)?.has(key) ?? false
  }
}

function payloadName(payload: IngestPayload): string {
  if (payload.type === 'track') return payload.event
  if (payload.type === 'page') return payload.name ?? '$page'
  return '$identify'
}

function payloadProperties(payload: IngestPayload): Record<string, unknown> {
  if (payload.type === 'identify') return payload.traits
  return payload.properties
}

export function checkLimits(
  payload: IngestPayload,
  tracker: CardinalityTracker,
  projectId = 0,
): LimitResult {
  const properties = payloadProperties(payload)
  const keys = Object.keys(properties)

  if (keys.length > MAX_PROPERTIES_PER_EVENT) {
    return {
      ok: false,
      reason: 'too_many_properties',
      detail: `${keys.length} properties exceeds the limit of ${MAX_PROPERTIES_PER_EVENT}`,
    }
  }

  const name = payloadName(payload)
  if (
    !tracker.knowsEventName(projectId, name) &&
    tracker.eventNameCount(projectId) >= MAX_EVENT_NAMES_PER_PROJECT
  ) {
    return {
      ok: false,
      reason: 'event_name_cardinality',
      detail: `Project already uses ${MAX_EVENT_NAMES_PER_PROJECT} distinct event names; "${name}" was rejected`,
    }
  }

  // A single event can carry up to MAX_PROPERTIES_PER_EVENT brand-new keys at
  // once, so the cap must be enforced against existing + incoming novel keys
  // together — checking only the pre-existing count would let one event push
  // the real total hundreds over the limit before the guard ever engages.
  const existingKeyCount = tracker.propertyKeyCount(projectId, name)
  const novelKeys = keys.filter((k) => !tracker.knowsPropertyKey(projectId, name, k))
  if (existingKeyCount + novelKeys.length > MAX_PROPERTY_KEYS_PER_EVENT_NAME) {
    const novel = novelKeys[0]
    if (novel !== undefined) {
      return {
        ok: false,
        reason: 'property_key_cardinality',
        detail: `Event "${name}" would exceed the limit of ${MAX_PROPERTY_KEYS_PER_EVENT_NAME} distinct property keys; "${novel}" was rejected`,
      }
    }
  }

  return { ok: true }
}
