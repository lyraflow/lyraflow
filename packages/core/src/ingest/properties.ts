import { escapeControlCharacters } from './control-chars.js'
export const MAX_ID_LENGTH = 128
/** Shared with the browser SDK, which warns before sending rather than after. */
export const MAX_PROPERTIES_PER_EVENT = 250

/**
 * Context string caps, enforced by `Context` in `payloads.js`.
 *
 * Named constants rather than literals inside the schema because the browser
 * SDK has to hold the same numbers — it cannot import Zod, so it re-declares
 * them and `validate.test.ts` pins its copies against these. A URL over the
 * cap does not merely lose the URL: the whole event fails validation and is
 * dead-lettered, which is why the SDK truncates to these before sending.
 */
export const MAX_URL_LENGTH = 2048
export const MAX_USER_AGENT_LENGTH = 1024

export type PropertyValue = string | number | boolean | null

export interface RoutedProperties {
  properties: Record<string, string>
  properties_num: Record<string, number>
}

/**
 * The prefix Lyraflow reserves for its own property keys.
 *
 * `$` already meant "Lyraflow owns this name" for EVENT names -- `$page`,
 * `$identify` -- but only because two call sites happened to spell it, and
 * nothing reserved it for property keys at all. #53 needed one (`$page_name`),
 * and a key the product writes has to be a key a caller cannot forge.
 */
export const RESERVED_PROPERTY_PREFIX = '$'

/**
 * Splits a flat property bag into the two ClickHouse Map columns.
 *
 * The routing rule is per value, not per key: a value that is a finite number
 * goes to properties_num, everything else is stringified into properties. The
 * same key may therefore land in different maps across different events, which
 * is expected — event_schema records the observed kinds.
 *
 * **Caller-supplied keys starting with `$` are dropped here**, and this is the
 * only place that decision is made. Three things follow from putting it here
 * rather than anywhere else:
 *
 * - **It holds across BOTH maps.** Routing is per VALUE, so `$page_name: 'x'`
 *   lands in `properties` and `$page_name: 42` lands in `properties_num`. A
 *   guard that defended only the string map would MOVE the collision into the
 *   column no reader of the page name looks in, which is worse than no guard:
 *   the value would be unfindable rather than merely wrong.
 * - **Lyraflow's own keys are written AFTER routing** (`toEventRow`), so they
 *   never pass through this filter. That is what makes "only Lyraflow can
 *   write a `$` key" a property of one function instead of a convention.
 * - **A prefix, not a list of reserved names.** The alternative was reserving
 *   `$page_name` specifically, and the second reserved key would have restated
 *   the whole argument. A ban-list is the wrong tool the moment it needs a
 *   second entry.
 *
 * Dropped rather than rejected, because ingest accepts and degrades everywhere
 * else: a `null` value, an empty key and an over-long key are already dropped
 * or truncated here without failing the event. Refusing an otherwise valid
 * event over a property key would be a new class of hard failure for a
 * careless client, and the write key is public, so it would also be a new way
 * for a visitor to make a site's events disappear.
 */
export function routeProperties(input: Record<string, PropertyValue>): RoutedProperties {
  const properties: Record<string, string> = {}
  const properties_num: Record<string, number> = {}

  for (const [rawKey, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue
    // Truncate FIRST, then escape (#35). The other order can cut a `\xNN`
    // sequence in half and store a `\x1` that means nothing. Escaping can
    // therefore push a hostile key past MAX_ID_LENGTH, which is accepted:
    // an ordinary key is unchanged by it, and the column is unbounded.
    const key = escapeControlCharacters(rawKey.slice(0, MAX_ID_LENGTH))
    if (key.length === 0) continue
    // Checked on the RAW key, before truncation: truncation can only shorten a
    // string, never remove its first character, so the two are equivalent --
    // but reading the reservation off the caller's own bytes is the version
    // that stays true if the cap ever changes.
    if (rawKey.startsWith(RESERVED_PROPERTY_PREFIX)) continue

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
