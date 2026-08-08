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
export const MAX_URL_LENGTH = 2048
export const MAX_USER_AGENT_LENGTH = 1024

/**
 * The four context fields the server caps, and the cap it applies to each.
 * Nothing in the SDK bounded these, and the server rejects the WHOLE event
 * when one is exceeded — a 2,141-character OAuth callback URL, which is an
 * ordinary thing for a page to have, cost the entire event and every
 * property on it. The remaining context fields (the five `utm_*`) are capped
 * at `MAX_ID_LENGTH`, and are not truncated here: a mangled campaign name
 * silently attributed to the wrong campaign is worse than a warning.
 *
 * That choice means an over-long `utm_*` still costs the whole event, by
 * design. The transport's `rejected` warning (`#reportRejected`) is the only
 * thing standing between that case and complete silence — if that ever goes,
 * this decision has to be revisited with it.
 */
const CONTEXT_LIMITS: [string, number][] = [
  ['url', MAX_URL_LENGTH],
  ['path', MAX_URL_LENGTH],
  ['referrer', MAX_URL_LENGTH],
  ['user_agent', MAX_USER_AGENT_LENGTH],
]

/**
 * The one implementation of the context caps, in both modes.
 *
 * `truncate` decides whether an over-long field is SHORTENED in place or
 * merely reported. Truncating is the lesser loss and it is not close: a
 * shortened `url` costs the query string of one event, while sending it whole
 * costs the event, its properties and the identity attached to it — silently,
 * behind a `202`.
 *
 * The cut is by code unit and can land inside a percent-escape, leaving a
 * trailing bare `%` — so the stored value is not strictly a valid URL. It is
 * accepted: it happens once (this runs before the event is queued, never on a
 * retry), it is idempotent, and nothing downstream decodes stored URLs.
 * Trimming to an escape boundary would cost bytes in a bundle with a hard
 * ceiling to buy correctness nothing reads.
 */
function contextProblems(e: QueuedEvent, truncate: boolean): string[] {
  const out: string[] = []
  const ctx = e.context as Record<string, unknown> | undefined
  if (!ctx || typeof ctx !== 'object') return out
  for (const [field, limit] of CONTEXT_LIMITS) {
    const value = ctx[field]
    if (typeof value === 'string' && value.length > limit) {
      if (truncate) ctx[field] = value.slice(0, limit)
      out.push(
        `context.${field} was ${value.length} characters, ${truncate ? 'truncated' : 'over'} the ${limit} limit`,
      )
    }
  }
  return out
}

/**
 * Truncates over-long context strings IN PLACE and returns one message per
 * field it touched. The only mutating export in this file, and deliberately
 * separate from `validateEvent` because of it.
 */
export function clampContext(e: QueuedEvent): string[] {
  return contextProblems(e, true)
}

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

  // Reports only; it never mutates. In practice this fires for a context
  // this SDK did not build — everything going out through enqueueOrHold has
  // been through `clampContext` already, which leaves nothing over a cap.
  for (const problem of contextProblems(e, false)) out.push(problem)

  checkBag(e.properties, 'properties', out)
  checkBag(e.traits, 'traits', out)
  return out
}
