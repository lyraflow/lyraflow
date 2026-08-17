/**
 * The one conversion between what `<input type="datetime-local">` speaks and
 * what the AST stores. One module, because two spellings of a timezone
 * conversion is exactly how they drift -- `ConditionRow` grew the first one
 * (`datetimeLocal`, for a `lifecycle` default) and `WindowPicker` needed the
 * same idea for the `absolute` window, in the opposite direction.
 *
 * There are TWO formats here and they are not interchangeable:
 *
 * - **The picker's own format**, `YYYY-MM-DDTHH:mm`, is LOCAL WALL-CLOCK with
 *   no zone at all. It is what the input renders and what it writes back, and
 *   it is the only thing the input will display: hand it a `Z`-suffixed
 *   instant and it shows an empty control.
 * - **A stored instant** is a UTC ISO string with a `Z`. `ast.ts` declares an
 *   `absolute` window's bounds as `z.string().datetime()`, which requires
 *   exactly that -- verified against the compiled schema rather than read off
 *   the source, because the answer is not obvious: `2026-08-01T10:00` is
 *   REJECTED, and so is `2026-08-01T10:00:00+05:30`, since zod's default
 *   `.datetime()` allows no offset either.
 *
 * A person who picks "1 Aug, 10:00" means 10:00 where THEY are, so the rule
 * is store UTC, display local -- and say which zone the picker is showing, at
 * the control, because an unlabelled datetime is ambiguous and the operator
 * would otherwise discover the answer from a count that is five and a half
 * hours off.
 *
 * Both conversions are idempotent, deliberately: `toInstant` of an instant is
 * that instant, and `toPickerValue` of a picker value is that picker value.
 * A conversion accidentally applied twice therefore cannot corrupt anything.
 * What that does NOT protect against is applying one of them and not the
 * other, which is what the round-trip tests exist for.
 */

/**
 * Whether a stored string names an INSTANT rather than a wall-clock reading
 * -- i.e. whether it carries a zone designator at all.
 *
 * The `T` in front is load-bearing: without it, the `[+-]\d{2}:?\d{2}` half
 * would have to be trusted not to match the `-08-01` of a bare date, and
 * "trusted not to" is how this class of bug is written. Anchored at the end,
 * so only a trailing designator counts.
 */
const CARRIES_A_ZONE = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * A `Date` rendered in the picker's own format -- LOCAL wall-clock, built
 * from the local getters rather than from `toISOString()`, which would be UTC
 * with a `Z` the input refuses to display at all.
 *
 * Used directly by `ConditionRow` to seed a fresh `lifecycle` node's value
 * (whose schema is a looser refine that accepts a zone-less reading; see this
 * module's tests), and by `toPickerValue` below.
 */
export function datetimeLocal(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * A picker reading -> the instant to STORE. `new Date(local)` is what does
 * the work: the language parses a zone-less date-time form as local time,
 * which is precisely what the control means, and `toISOString()` then names
 * that instant in UTC.
 *
 * Two non-conversions, both deliberate:
 *
 * - `''` stays `''`. An empty bound means "not filled in yet", which the
 *   schema refuses and the row reports as unfinished -- inventing an instant
 *   for it would turn a blank into a silent "now".
 * - Anything unparseable is returned UNCHANGED rather than blanked. A
 *   half-typed value is the operator's own text and belongs back on screen;
 *   the schema rejects it, and the row says so.
 */
export function toInstant(local: string): string {
  if (local === '') return ''
  const at = new Date(local)
  if (Number.isNaN(at.getTime())) return local
  return at.toISOString()
}

/**
 * A stored value -> what the picker should DISPLAY.
 *
 * A string with no zone designator is passed through untouched, and that is
 * not merely a convenience. It is what keeps this safe to point at a field
 * whose stored values are zone-less wall-clock readings (`lifecycle`, whose
 * refine accepts them): shifting such a value by the local offset would move
 * an instant nobody edited. Only a string that actually names an instant is
 * converted.
 */
export function toPickerValue(stored: string): string {
  if (stored === '') return ''
  if (!CARRIES_A_ZONE.test(stored)) return stored
  const at = new Date(stored)
  if (Number.isNaN(at.getTime())) return stored
  return datetimeLocal(at)
}

/**
 * The IANA name of the zone the picker is showing, e.g. `Europe/Istanbul` --
 * read from the runtime, never guessed, and never compared against a literal
 * in a test either (a host resolves `Asia/Kolkata` to `Asia/Calcutta`, which
 * is the same zone under an older name).
 */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
