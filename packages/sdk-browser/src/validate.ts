import type { QueuedEvent } from './payload.js'

/**
 * Declared here rather than imported from @lyraflow/core, because any VALUE
 * import from core fails the bundle outright — its barrel re-exports a module
 * that reaches for node:crypto. `import type` is erased and therefore free;
 * these two are not.
 *
 * The duplication is deliberate and guarded: validate.test.ts asserts these
 * equal core's own constants. Test files run in Node and are never bundled, so
 * importing core there costs nothing.
 */
export const MAX_ID_LENGTH = 128
export const MAX_PROPERTIES_PER_EVENT = 250

function checkBag(bag: Record<string, unknown> | undefined, label: string, out: string[]): void {
  if (!bag) return
  const keys = Object.keys(bag)
  if (keys.length > MAX_PROPERTIES_PER_EVENT) {
    out.push(`${label}: ${keys.length} keys exceeds the limit of ${MAX_PROPERTIES_PER_EVENT}`)
  }
  for (const key of keys) {
    // bag[key] can be a getter the caller controls (directly, or indirectly
    // through a library that handed them a property bag with computed
    // accessors). This function's entire contract is "report problems,
    // never throw" — a read that's allowed to escape breaks that contract
    // one property in, and does so silently: the caller sees a generic
    // "something went wrong" from whatever wraps this call, not a hint
    // that one property was the cause.
    let value: unknown
    try {
      value = bag[key]
    } catch {
      out.push(`${label}.${key} could not be read`)
      continue
    }
    const ok =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    if (!ok) {
      out.push(
        `${label}.${key} is ${Array.isArray(value) ? 'an array' : typeof value}; only string, number, boolean and null are stored`,
      )
    }
  }
}

/**
 * The rules the README documents, checked before sending — because the ingest
 * answers 202 for malformed events by design and tells the caller nothing.
 *
 * Returns problems; it never mutates the event and never prevents a send. An
 * SDK that silently drops your data is worse than a server that quietly
 * dead-letters it.
 */
export function validateEvent(e: QueuedEvent): string[] {
  const out: string[] = []

  if (!e.anonymous_id && !e.user_id) out.push('neither anonymous_id nor user_id is set')
  for (const [label, value] of [
    ['anonymous_id', e.anonymous_id],
    ['user_id', e.user_id],
    ['event', e.event],
    ['name', e.name],
  ] as const) {
    // QueuedEvent types this as string | undefined, but that's a compile-time
    // promise only — this SDK ships to JavaScript callers, where nothing
    // stops a runtime value of 12345 or null reaching here. The server's Zod
    // schema rejects a non-string id outright; treating it as "absent" (via
    // `.length` throwing or coercing) would let it sail through this check
    // as clean when the server would dead-letter it.
    if (value === undefined) continue
    if (typeof value !== 'string') {
      out.push(`${label} must be a string, got ${value === null ? 'null' : typeof value}`)
      continue
    }
    if (value.length === 0 || value.length > MAX_ID_LENGTH) {
      out.push(`${label} must be 1 to ${MAX_ID_LENGTH} characters, got ${value.length}`)
    }
  }
  if (e.type === 'track' && !e.event) out.push('track requires an event name')
  if (e.type === 'identify' && !e.user_id) out.push('identify requires a user_id')

  checkBag(e.properties, 'properties', out)
  checkBag(e.traits, 'traits', out)
  return out
}
