/**
 * Parses a path/query param into a positive, safe-integer database id, or
 * `null` if it is not one. The single implementation every route's own
 * `parse*Id` wraps, so a new route gets this convention BY CONSTRUCTION
 * rather than by a local function someone had to remember to write the same
 * way. That is not a hypothetical: this repo shipped two independent
 * copies that skipped the shape check below — `segments/routes.ts`'s
 * `parseSegmentId` and `privacy/routes.ts`'s `parseDeletionId` — and the
 * latter's own comment said it was mirroring the former, which means the
 * bug propagated by example. A single named source of truth is the only
 * fix that survives the next route being copied from whichever one is
 * nearest.
 *
 * `/^\d+$/` first, so `Number()` never sees anything it could coerce —
 * `'0x10'`, `' 1 '`, `'+5'` and `'1e3'` all parse to a normal-looking
 * finite number under a bare `Number()` call, and `Number.isInteger(1e21)`
 * is `true`. Then `Number.isSafeInteger`, so a value that IS all digits but
 * outside safe-integer range (e.g. `'99999999999999999999'`) is refused
 * too — those values are exactly as valid-looking to Postgres/ClickHouse
 * bind parameters as any other out-of-range id, and would otherwise reach
 * a query the database itself rejects, turning a deterministic client
 * error into an app.ts catch-all `503`.
 *
 * Every caller keeps its own thin wrapper (`parseId`, `parseProjectId`,
 * `parseSegmentId`, `parseDeletionId`) rather than calling this directly at
 * each site — the wrapper's name documents WHICH id a given route is
 * parsing, and its own doc comment carries that route's specific 400-vs-404
 * reasoning, which belongs with the route, not here.
 */
export function parseNumericId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
