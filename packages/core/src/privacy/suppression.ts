import type { Params } from '../segments/params.js'

/**
 * The far-future default for the boundary lookup, written as epoch seconds
 * rather than a date literal.
 *
 * 4294967295 is the largest instant a ClickHouse DateTime can hold, and
 * DateTime is stored as an unsigned epoch-second count — so a numeric literal
 * means exactly the same thing regardless of the server's timezone setting,
 * where `toDateTime('2106-02-07 06:28:15')` would be parsed IN that timezone
 * and land somewhere else on a server that is not UTC.
 */
export const SUPPRESSION_NEVER = 'toDateTime(4294967295)'

/**
 * "This row survives suppression" — the one derivation of the dictionary-side
 * boundary, used by every ClickHouse read path.
 *
 * The two halves have OPPOSITE failure modes, and that is the whole design:
 *
 *  - `dictHas` on a dictionary that never loaded THROWS (Code: 156 — measured
 *    against a live server, not assumed). The query fails. Fail closed, and
 *    loud.
 *  - `dictGetOrDefault` returns the caller's default on the same dictionary.
 *    That is precisely how Plan 2's identity resolution degraded to "nobody
 *    was ever identified" with nothing erroring.
 *
 * Written as `instant <= dictGetOrDefault(..., <far past>)` alone, a failed
 * dictionary would report "not suppressed" for every person and republish
 * everyone who ever asked to be deleted — the worst failure available to this
 * feature. So `dictHas` stays the guard, and the default is the FAR FUTURE:
 * reached on its own it hides data rather than reveals it. Both halves fail
 * toward suppression.
 *
 * `database` is interpolated, not bound — a dictionary name cannot be a query
 * parameter. It comes from this process's own configuration and never from a
 * request, the same way `compileSegment` has always used it. `person` and
 * `instant` are SQL EXPRESSIONS chosen by the caller from a fixed set of call
 * sites in this repo, never assembled from request data; every VALUE inside
 * them is separately bound by whoever built them.
 *
 * The caller supplies `instant` because the four read paths genuinely ask
 * different questions of one boundary: the base population compares a
 * person's `last_seen`, the behavioural pass compares each event's own
 * `timestamp`. What must not be duplicated is what this function contains —
 * the guard, the attribute name, the default, and the direction of the
 * comparison.
 */
export function notSuppressedExpr(opts: {
  database: string
  projectId: number
  params: Params
  person: string
  instant: string
}): string {
  const { database, projectId, params, person, instant } = opts
  const dict = `'${database}.suppressed_persons'`
  // One `add` call, one parameter, reused in both halves: a second binding of
  // the same value would be harmless but would suggest the two lookups could
  // legitimately disagree about which project they are asking about.
  const key = `(${params.add(projectId, 'UInt32')}, ${person})`
  return (
    `NOT (dictHas(${dict}, ${key})` +
    ` AND ${instant} <= dictGetOrDefault(${dict}, 'suppressed_at', ${key}, ${SUPPRESSION_NEVER}))`
  )
}
