import type { PropertyKind, SchemaProperty } from '../../api/types.js'
import type { ConditionValue, Scalar } from './ValueInput.js'

/**
 * A predicate's value, retyped to match the property it names.
 *
 * ## Why a value's JavaScript type is load-bearing
 *
 * Ingest routes a finite number into `properties_num` and everything else
 * into `properties` (`routeProperties`, core). A predicate reads exactly ONE
 * of those two maps, and `wherePredicate` picks which from `typeof value ===
 * 'number'` -- the same rule `traitExpr` uses for `t_str` / `t_num`. That
 * works for the HTTP API, where JSON tells `21` and `"21"` apart.
 *
 * It did not work here, and could not: every control this builder renders
 * yields `e.target.value`, so a predicate written in the browser was always a
 * string and always read the string map. A condition on a numeric property
 * validated, saved, and matched nothing -- verified live at the time of the
 * fix as `results = "21"` finding 0 people where `results = 21` found 31.
 *
 * ## Why the schema decides and not the text
 *
 * `event_schema` records the kind per key, and it is the only thing that
 * knows: "21" is a number for `results` and text for an order id, and the
 * text alone cannot tell those apart. Guessing from the shape of the input
 * would trade one silent zero for a rarer one.
 *
 * So `kind` comes from `GET /v1/schema/properties`, and:
 *
 * - `number` converts any parseable value, INCLUDING one a round-trip test
 *   would refuse. `02134` becomes `2134`, because the schema says this key
 *   holds numbers and `2134` is what `properties_num` would hold for it.
 * - `string` converts back, so a row moved from a numeric property to a text
 *   one does not leave a number reading the string map -- the same bug with
 *   the maps swapped.
 * - `mixed` and `undefined` change nothing. Both mean "not established", and
 *   a coercion made on a guess is what this function exists to avoid. The
 *   row says so instead; see `kindNote`.
 *
 * An EMPTY string is never converted: `Number('')` is 0, and turning a row
 * the operator has not finished into `= 0` would be inventing a predicate
 * they did not write.
 *
 * Returns the value UNCHANGED, by identity, when nothing needs doing --
 * callers self-heal from an effect and compare by reference to decide
 * whether to write back.
 */
export function coerceForKind(
  value: ConditionValue,
  kind: PropertyKind | undefined,
): ConditionValue {
  if (kind !== 'number' && kind !== 'string') return value
  if (Array.isArray(value)) {
    const [lo, hi] = value
    const next: [Scalar, Scalar] = [coerceScalar(lo, kind), coerceScalar(hi, kind)]
    return next[0] === lo && next[1] === hi ? value : next
  }
  return coerceScalar(value, kind)
}

function coerceScalar(value: Scalar, kind: 'string' | 'number'): Scalar {
  if (kind === 'number') {
    if (typeof value !== 'string' || value.trim() === '') return value
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  return typeof value === 'number' ? String(value) : value
}

/**
 * The line a row shows when its property's kind could not be established and
 * the value looks like a number.
 *
 * This is the residue of the bug, said out loud. A name the project has never
 * recorded, or one it has recorded both ways, leaves nothing to coerce
 * against -- so the predicate stays text, exactly as it always was, and will
 * not match events that sent the key as a number. Before this line the only
 * evidence of that was a count of zero.
 *
 * Silent for a value that is not numeric-looking: `plan = pro` cannot be
 * suffering from this, and a note on every unrecorded property would be noise
 * on the legitimate case this builder is explicitly designed for -- writing a
 * definition ahead of the data that fills it.
 */
export function kindNote(
  property: string,
  kind: PropertyKind | undefined,
  value: ConditionValue,
): string | null {
  const looksNumeric = (v: ConditionValue): boolean => {
    if (Array.isArray(v)) return v.some(looksNumeric)
    return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
  }
  if (property.trim() === '' || !looksNumeric(value)) return null
  if (kind === 'mixed') {
    return `"${property}" has been recorded both as text and as a number. This condition reads it as text, so events that sent it as a number will not match.`
  }
  if (kind === undefined) {
    return `Nothing is recorded under "${property}" for this event yet, so this condition reads it as text. If your app sends it as a number, this will not match.`
  }
  return null
}

/**
 * Folds every kind a lookup reported into what a caller already knew.
 *
 * Accumulating rather than replacing, and keyed by NAME rather than by row:
 * a lookup is scoped to whatever text is in one box, so the answer for a
 * property stops being returned as soon as the operator types past it, and a
 * map that replaced itself would forget the kind of the very property it was
 * about to coerce. Two rows naming one property also share one answer, which
 * is correct -- the kind belongs to the property, not to the row.
 *
 * Returns the SAME object when nothing is new, so a caller holding this in
 * state does not re-render on every lookup that told it what it already knew.
 */
export function learnKinds(
  known: Record<string, PropertyKind>,
  reported: SchemaProperty[],
): Record<string, PropertyKind> {
  let next = known
  for (const p of reported) {
    if (next[p.name] === p.kind) continue
    if (next === known) next = { ...known }
    next[p.name] = p.kind
  }
  return next
}
