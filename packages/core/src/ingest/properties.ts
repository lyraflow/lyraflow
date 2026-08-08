export const MAX_ID_LENGTH = 128
/** Shared with the browser SDK, which warns before sending rather than after. */
export const MAX_PROPERTIES_PER_EVENT = 250

export type PropertyValue = string | number | boolean | null

export interface RoutedProperties {
  properties: Record<string, string>
  properties_num: Record<string, number>
}

/**
 * Splits a flat property bag into the two ClickHouse Map columns.
 *
 * The routing rule is per value, not per key: a value that is a finite number
 * goes to properties_num, everything else is stringified into properties. The
 * same key may therefore land in different maps across different events, which
 * is expected — event_schema records the observed kinds.
 */
export function routeProperties(input: Record<string, PropertyValue>): RoutedProperties {
  const properties: Record<string, string> = {}
  const properties_num: Record<string, number> = {}

  for (const [rawKey, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue
    const key = rawKey.slice(0, MAX_ID_LENGTH)
    if (key.length === 0) continue

    if (typeof value === 'number') {
      if (Number.isFinite(value)) properties_num[key] = value
      continue
    }
    if (typeof value === 'boolean') {
      properties[key] = value ? 'true' : 'false'
      continue
    }
    if (typeof value === 'string') {
      properties[key] = value
    }
  }

  return { properties, properties_num }
}
