/**
 * What a lifecycle bound with no timezone means (#124).
 *
 * ## The decision
 *
 * **A zone-less lifecycle value is UTC.** Not the server's zone, not the
 * operator's — UTC, by fiat, documented, and the same answer everywhere.
 *
 * ## What it replaces
 *
 * `predicates.ts` resolved these with a bare `new Date(v)`, and JavaScript's
 * parsing rules make that answer depend on where the process thinks it is: a
 * date-TIME string with no designator is interpreted in the runtime's local
 * zone. So the same stored segment meant a different instant on a server in
 * Berlin than on one in São Paulo, and moving a deployment between zones — or
 * a container picking up a different `TZ` — silently changed which people it
 * matched, with no error and no visible change to the definition.
 *
 * (A date-ONLY string is the exception, and it is the exception in the spec
 * rather than in this codebase: `new Date('2026-08-01')` is already UTC. That
 * inconsistency is exactly why this function exists rather than a rule of
 * thumb about when to append a `Z`.)
 *
 * ## Why UTC rather than the alternatives
 *
 * Zone-less bounds already exist in stored segments, so every option changes
 * something:
 *
 * - **UTC by fiat** (this one) ends with a single unambiguous encoding, and it
 *   is what every other timestamp in the system already means — ClickHouse
 *   stores `DateTime64(3, 'UTC')`, the wire speaks ISO with `Z`. The cost is
 *   that a bound written by an operator whose server was NOT on UTC now means
 *   a different instant than it did, shifted by that server's offset.
 * - **Zone-carrying on new writes, server-zone on old ones** avoids that shift
 *   and buys a permanent ambiguity instead: two indistinguishable encodings in
 *   one column, forever, with nothing in a stored value saying which it is.
 * - **Migrating stored values** needs the zone each was written in, which was
 *   never captured. It can only be assumed, which is the first option wearing
 *   a disguise.
 *
 * The shift is bounded, visible in the UI the moment a segment is opened, and
 * it happens once. The ambiguity is unbounded and permanent.
 *
 * ## The UI reads the same rule
 *
 * `datetime.ts` converts a zone-less stored value from UTC to local for
 * display, so the picker shows the same instant this function compiles. That
 * is what makes a bare date renderable at all (#126): it is no longer "a
 * reading whose zone nobody has decided", it is midnight UTC.
 */

/**
 * Whether a stored string carries a zone designator.
 *
 * The leading `T` is BELT AND BRACES, not a load-bearing guard, and saying so
 * because the comment this replaces claimed the opposite. Removing it was
 * mutation-tested and every test still passed: `-08-01` cannot match
 * `[+-]\d{2}:?\d{2}$` anyway, since after `-08` the pattern needs two more
 * digits and finds `-`. The anchor is kept because it makes the intent
 * readable at a glance, not because anything currently depends on it.
 *
 * What IS pinned is the behaviour: a bare date and a zone-less date-time are
 * zone-less; `Z` and a `+05:30`-style offset are not.
 */
export const CARRIES_A_ZONE = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i

/** A date with no time at all, which the spec already resolves as UTC. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Resolve a stored lifecycle bound to an instant, reading a zone-less value
 * as UTC.
 *
 * Returns an Invalid Date for anything unparseable, exactly as `new Date`
 * does — the schema's refine is what rejects those, and this must not start
 * throwing where the compiler previously produced a value.
 */
export function lifecycleInstant(value: string): Date {
  if (CARRIES_A_ZONE.test(value)) return new Date(value)
  if (DATE_ONLY.test(value)) return new Date(`${value}T00:00:00Z`)
  // A zone-less date-TIME. Appending the designator is what changes the
  // reading from "local to whoever is running this" to UTC, and it works for
  // every shape the schema admits: `…THH:mm`, `…:ss`, and `…:ss.sss`.
  return new Date(`${value}Z`)
}
