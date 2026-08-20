/**
 * The words this screen reads a stored filter tree in -- ONE source, read by
 * every surface that renders a condition to a person.
 *
 * Why this module exists at all: the plain-language rewording originally
 * landed in the builder's own controls, and the two OTHER places a condition
 * is rendered as prose (`summarise`, which the segments list and the segment
 * detail screen both show) kept speaking the AST -- raw `>=`, and the
 * phrase "in ever", which is not English. That was not an oversight in either
 * file; it is what happens when a vocabulary lives inside the component that
 * happened to need it first. Two lists that must agree drift, so the operator
 * words and the window phrasing live here, with `OperatorSelect`,
 * `WindowPicker` and `summarise` all reading them.
 *
 * PRESENTATION ONLY. Nothing here reaches a node: `value` on every option is
 * the AST's own spelling, unchanged, so every test (and every caller) that
 * selects by value keeps working, and the CLI -- which prints ids, names and
 * counts, and deliberately renders no tree as prose at all -- is untouched.
 */
import { COMPARISON_OPERATORS, wherePredicateField } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator, WherePredicate, Window } from '@lyraflow/core/segments/ast.js'
import { lifecycleInstant } from '@lyraflow/core/segments/instants.js'

/**
 * The word an operator reads as.
 *
 * A `Record<ComparisonOperator, string>` rather than a lookup with a
 * fallback, deliberately. The fallback spelling (`OPERATOR_WORDS[op] ?? op`)
 * is the one that fails silently: an operator added to `COMPARISON_OPERATORS`
 * in core renders as a raw symbol in five selects and one summary, and nothing
 * anywhere goes red. With an exhaustive record, `tsc` refuses to compile until
 * the new operator has a word -- which is a guard no test can express, so this
 * module's tests pin the observable half instead (every operator in core has a
 * word, and no word is its own symbol).
 */
export const OPERATOR_WORDS: Record<ComparisonOperator, string> = {
  '=': 'is',
  '!=': 'is not',
  '>': 'more than',
  '>=': 'at least',
  '<': 'less than',
  '<=': 'at most',
  between: 'between',
}

/**
 * The word for an operator read off STORED data rather than off a control.
 *
 * `summarise` renders `segment.filter`, which arrives from the wire as
 * `unknown` and is cast -- so unlike the select, its operator is not
 * guaranteed by the type system to be one of core's. The fallback is the raw
 * symbol, which is what the summary used to show for every operator anyway;
 * the alternative is a bare index that renders the word `undefined` into a
 * sentence.
 *
 * This does NOT weaken the exhaustiveness guard above. That guard is about an
 * operator core DECLARES and this module forgot, which `tsc` still refuses;
 * this fallback is only reachable for a value that is not a
 * `ComparisonOperator` at all.
 */
export function operatorWord(operator: string): string {
  return OPERATOR_WORDS[operator as ComparisonOperator] ?? operator
}

/**
 * Every operator the AST accepts, in the order core declares them, each with
 * the word it reads as. Driven off `COMPARISON_OPERATORS` rather than off the
 * record's own keys, so the ORDER is core's and the list can never be a
 * subset of it.
 */
export const OPERATOR_OPTIONS: { value: ComparisonOperator; label: string }[] =
  COMPARISON_OPERATORS.map((value) => ({ value, label: OPERATOR_WORDS[value] }))

/**
 * The three window variants, in the order `ast.ts` declares them, with the
 * label a `<select>` option shows.
 *
 * These are the CONTROL's words, and they are not the same strings as
 * `windowPhrase` below -- a control offers a choice ("in the last…", with the
 * amount typed into the next field), a sentence states one ("in the last 90
 * days"). Both registers live in this one module because they are one
 * decision about how a window is named; what they must never be is one
 * register in a component and the other in a summary, which is exactly how
 * the list came to say "in ever" while the builder said "any time".
 */
export const WINDOW_KIND_OPTIONS: { kind: Window['kind']; label: string }[] = [
  { kind: 'last', label: 'in the last…' },
  { kind: 'absolute', label: 'between two dates' },
  { kind: 'ever', label: 'any time' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A stored datetime bound, as PROSE: `1 Jul 2026, 03:00`.
 *
 * Three decisions, none of them cosmetic:
 *
 * - **It shows the same instant the picker does, and the same one the SQL
 *   matches**, because all three resolve the stored string through core's
 *   `lifecycleInstant`. A zone-less bound is UTC (#124), so there is no longer
 *   a "wall-clock reading whose zone nobody decided" case to special-case --
 *   which is what used to make a bare date unrenderable (#126). A bound read
 *   in a list summary, the same bound opened in the builder, and the rows it
 *   actually selects cannot disagree, by construction rather than by three
 *   conversions that happen to match.
 * - **Absolute, not relative.** `formatRelative` is right for a "last
 *   evaluated" instant, which is an event that happened and whose interest is
 *   how long ago. A window bound is a CHOICE the operator made: rendering
 *   `2026-07-01` as "47 days ago" would restate a fixed bound as a moving one
 *   and would read differently every day the segment is untouched.
 * - **Day first, month named, 24-hour clock.** A named month cannot be read
 *   as `07/01` vs `01/07`, day-first keeps the whole reading to one comma (so
 *   two of them joined by `and` in a sentence stay legible), and a 24-hour
 *   clock has no AM/PM to clip or mistake -- the one thing this loses against
 *   the native picker's `12:00 AM` is familiarity, and it gains that back by
 *   naming midnight `00:00` rather than a "12" that could be either end of
 *   the day.
 *
 * Seconds are shown only when they are not zero: a bound stored to the second
 * is unusual, and silently dropping the `:07` off one would misreport it,
 * while printing `:00` on every ordinary bound is noise.
 *
 * Anything unparseable -- an empty bound (an unfinished condition), a
 * half-typed value, a nonsense month -- comes back exactly as stored. It is
 * the operator's own text, and the row that shows it says separately that the
 * condition is not finished.
 */
export function formatBound(stored: string): string {
  // Resolved through core's `lifecycleInstant` -- the SAME function the
  // compiler uses -- and then rendered from local getters, rather than routed
  // through the picker's format.
  //
  // It used to go through `toPickerValue`, which is `YYYY-MM-DDTHH:mm` and
  // carries NO seconds: a bound stored as `09:00:07` summarised as `09:00`,
  // silently dropping precision this function's own doc comment promises to
  // keep. The picker has to drop them because the control cannot display
  // them; a sentence has no such constraint.
  const at = lifecycleInstant(stored)
  if (Number.isNaN(at.getTime())) return stored
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`
  const seconds = at.getSeconds() !== 0 ? `:${pad(at.getSeconds())}` : ''
  // A bare date now renders WITH its time (#124/#126). It names midnight UTC,
  // which is a real instant and is rarely local midnight -- printing the date
  // alone would imply a whole-day meaning it does not have, and would disagree
  // with the row the operator opens in the builder.
  return `${date}, ${pad(at.getHours())}:${pad(at.getMinutes())}${seconds}`
}

/**
 * A window as a PHRASE inside a sentence -- the register `summarise` needs,
 * and the reason the raw `kind` never reaches a reader.
 *
 * `ever` is the one this module was written for. It used to be rendered as
 * `in ${kind}`, which spelled "in ever": not English, and the least readable
 * thing on the screen an operator sees most. Each variant now carries its own
 * preposition, so no caller has to guess which one fits.
 *
 * `absolute` reads `from X to Y` rather than `between X and Y`, and that is a
 * collision avoided rather than a preference: `between` is also a comparison
 * operator, and a behaviour with both renders "... between 1 Jul 2026, 03:00
 * and 15 Aug 2026, 03:00 between 100 and 5000", where neither `between` can
 * be told from the other. The control's own label stays "between two dates",
 * which is unambiguous there because it names no bounds.
 */
export function windowPhrase(window: Window): string {
  switch (window.kind) {
    case 'last':
      return `in the last ${window.n} ${window.unit}`
    case 'absolute':
      return `from ${formatBound(window.from)} to ${formatBound(window.to)}`
    case 'ever':
      return 'at any time'
    default:
      return window satisfies never
  }
}

/**
 * A condition's value, as prose.
 *
 * `between` carries a two-slot tuple (`ValueInput`'s own doc comment), which
 * reads as "X and Y" -- so the join is part of the VALUE's rendering rather
 * than the operator's, and `formatScalar` is applied to each slot rather
 * than to the pair.
 *
 * `formatScalar` is how a `lifecycle` bound gets rendered as a date while a
 * trait value is left exactly as stored: a trait's value is arbitrary
 * operator data that merely might look like a date, and reformatting it
 * would be inventing a type for it.
 *
 * Lives here rather than in `summarise.ts`, where it started, because the
 * funnel screens render a `where` clause too and a second copy of "how a
 * value reads" is the same drift `operatorWord` exists to prevent -- one
 * copy would have kept `between`'s "and" and the other would not.
 */
export function formatValue(value: unknown, formatScalar: (v: unknown) => string = String): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(v, formatScalar)).join(' and ')
  if (value === null) return 'null'
  return formatScalar(value)
}

/**
 * A `where` list as prose: `page is changelog, duration_ms at least 30`.
 *
 * WITHOUT the leading word "where" and without any terminator, deliberately.
 * It is a comma-separated list, so whatever follows it reads as one more
 * predicate unless the CALLER closes it -- `summarise` brackets the whole
 * behaviour when a group's join would otherwise be absorbed, and the funnel
 * screens bracket the clause itself. Baking a terminator in here would give
 * the callers that already close it two.
 *
 * Read by `summarise` (the segments list and detail), by the funnels list,
 * and by the funnel step bars, so the same predicate reads identically on
 * all four -- and so it reads in the operator's words on all four, which is
 * the whole reason `operatorWord` is not a raw `w.operator`.
 */
export function wherePhrase(where: readonly WherePredicate[]): string {
  return where
    .map((w) => {
      // The name only, whichever half of the union it came from: a summary
      // reads as a sentence, and "attribute utm_campaign is august-digest"
      // is not one. The cost is that a property named `path` and the column
      // named `path` summarise identically -- accepted, because the sentence
      // is a summary and the editor rows below it are the thing that says
      // which is which. Nothing here can tell them apart anyway: this
      // function sees one tree, never the project's property namespace.
      const { name } = wherePredicateField(w)
      return `${name} ${operatorWord(w.operator)} ${formatValue(w.value)}`
    })
    .join(', ')
}
