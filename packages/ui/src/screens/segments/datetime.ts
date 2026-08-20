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
 * `toInstant` is idempotent: `toInstant` of an instant is that instant, so
 * writing twice cannot corrupt.
 *
 * **`toPickerValue` is NOT, and that is a safety property #124 took away.** It
 * emits a zone-less LOCAL reading, and a zone-less string on the way IN now
 * means UTC -- so its output and its input are the same syntax with different
 * meanings, and applying it twice shifts twice. It used to be idempotent
 * precisely because zone-less values were passed through untouched, which is
 * the behaviour the ruling removed. What protects the screen instead is that
 * each direction is applied in exactly one place, and the round-trip tests
 * pin it. The loss is stated here, and pinned by its own test, so it is found
 * by reading rather than by watching a bound move five and a half hours on a
 * re-render.
 *
 * ## One encoding, one meaning (#124)
 *
 * `Lifecycle`'s refine is looser than an `absolute` window's `.datetime()`: it
 * accepts a zone-less reading as well as an instant, so both shapes are stored
 * in the field today. What changed is that they no longer mean different
 * things. **A zone-less lifecycle value is UTC**, decided by fiat and
 * implemented once, in core's `lifecycleInstant` -- which the compiler, this
 * module and the summary all call, so what the picker shows, what the sentence
 * says and what the SQL matches cannot disagree.
 *
 * Every read therefore converts, and a stored bound written before the ruling
 * by an operator whose server was not on UTC now names a different instant
 * than it did, shifted by that server's offset. That cost was taken
 * deliberately: it is bounded, it happens once, and it is visible the moment a
 * segment is opened -- against a permanent ambiguity that nothing in a stored
 * value could ever resolve.
 *
 * The residual #126 recorded -- a BARE DATE rendering as an empty control --
 * is gone with it. `2026-08-01` is midnight UTC, which is a local wall-clock
 * reading like any other.
 */

import { lifecycleInstant } from '@lyraflow/core/segments/instants.js'
import type { ConditionValue, Scalar } from './ValueInput.js'

/**
 * A `Date` rendered in the picker's own format -- LOCAL wall-clock, built
 * from the local getters rather than from `toISOString()`, which would be UTC
 * with a `Z` the input refuses to display at all.
 *
 * Used by `toPickerValue` below, and exported because it is the only honest
 * way to spell "the wall-clock reading a `Date` names here" -- see this
 * module's tests.
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
 * Every stored value is now an INSTANT, including one with no zone designator
 * (#124: those are UTC), so all of them convert to local for display. This
 * used to pass a zone-less value through untouched, because what it meant had
 * not been decided and shifting it would have moved an instant nobody edited.
 * The decision is made, so the special case is gone -- and its removal is what
 * makes a BARE DATE displayable at all (#126): `2026-08-01` is midnight UTC,
 * which is a local wall-clock reading like any other.
 *
 * Resolved through core's `lifecycleInstant`, the SAME function the compiler
 * uses, rather than a second reading of the same rule. What the picker shows
 * and what the SQL matches cannot disagree, because there is one function.
 *
 * Anything unparseable is returned UNCHANGED rather than blanked: a half-typed
 * value is the operator's own text and belongs back on screen, and the schema
 * is what rejects it.
 */
export function toPickerValue(stored: string): string {
  if (stored === '') return ''
  const at = lifecycleInstant(stored)
  if (Number.isNaN(at.getTime())) return stored
  return datetimeLocal(at)
}

/**
 * The two conversions above, lifted to a whole condition `value` -- which is
 * one scalar for every operator except `between`, and a two-slot tuple for
 * that one (`ValueInput`'s own doc comment).
 *
 * `WindowPicker` needs neither of these, because an `absolute` window names
 * its two bounds as separate fields and converts each one where it renders
 * it. A `lifecycle` bound is a condition `value`, so it arrives in whichever
 * of the two shapes the operator's chosen operator implies -- and a form that
 * converted only the scalar case would leave `between` writing back
 * unconverted readings, which is the same defect one operator to the left.
 *
 * A non-string scalar is passed through untouched. A number, a boolean or a
 * `null` is not something this picker can produce, and inventing a datetime
 * for one would be a conversion of something that was never a reading.
 */
function acrossValue(value: ConditionValue, convert: (s: string) => string): ConditionValue {
  const one = (v: Scalar): Scalar => (typeof v === 'string' ? convert(v) : v)
  return Array.isArray(value) ? [one(value[0]), one(value[1])] : one(value)
}

/** A stored condition value -> what the picker should DISPLAY. */
export function valueToPicker(stored: ConditionValue): ConditionValue {
  return acrossValue(stored, toPickerValue)
}

/** A condition value read off the picker -> what to STORE. */
export function valueToStored(picked: ConditionValue): ConditionValue {
  return acrossValue(picked, toInstant)
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
