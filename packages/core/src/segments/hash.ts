import { createHash } from 'node:crypto'

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two requests carrying the
 * same segment with their fields written in a different order produce
 * different text and therefore different cache keys. The cache would then
 * never hit for a client that does not happen to serialise consistently,
 * which is invisible: every response is still correct, and only the
 * snapshot-consistency guarantee for pagination quietly stops holding.
 *
 * Array order is preserved, because it is meaningful — the children of a
 * group are a sequence, and reordering them is a different tree to a reader
 * even where it is equivalent to the compiler.
 *
 * Non-plain objects (Date, Map, class instances, etc.) are rejected because
 * their enumerable properties do not capture their meaning, causing them to
 * serialise to `"{}"`. Two genuinely different values would then produce the
 * same hash, silently breaking the cache.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  // Reject non-plain objects to prevent silent collisions
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('canonicalJson accepts only plain JSON data')
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(',')}}`
}

/** Hex SHA-256 of the canonical form. Safe to embed in a cache key. */
export function treeHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
