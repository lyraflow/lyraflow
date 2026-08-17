/**
 * Renders a `FilterNode` as a single readable line -- the segments list's row
 * label, the segment detail screen's subtitle, and the builder's fallback for
 * a leaf kind with no form of its own. Pure and read-only: nothing here
 * reaches into the tree, it only reads.
 *
 * **The words come from `vocabulary.ts`, which the builder's own controls
 * read too.** This function used to spell the AST out literally -- `>=`,
 * `in ever`, and a UTC ISO string with milliseconds -- so the two screens an
 * operator spends most of their time on spoke a different language from the
 * one screen that had been reworded. `operatorWord`, `windowPhrase` and
 * `formatBound` are that vocabulary; nothing in this file decides what a
 * comparison or a window is called.
 *
 * What this file DOES still own is the word ORDER, and it is deliberately the
 * same order as before the rewording: `<clause> <window> <operator> <value>`.
 * The builder reads a behaviour top-down as "purchase count at least 3 times
 * / in the last 90 days", and matching that here would mean moving the window
 * behind the value -- which reads well for a bounded window ("at least 3
 * times in the last 90 days") and badly for the other two ("at least 20 times
 * at any time"). One line has to hold every variant, so the window keeps its
 * place and each variant carries its own preposition instead.
 */
import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { formatBound, operatorWord, windowPhrase } from './vocabulary.js'

/**
 * A condition's value. `between` carries a two-slot tuple (`ValueInput`'s own
 * doc comment), which reads as "X and Y" -- so the join is part of the
 * VALUE's rendering rather than the operator's, and `formatScalar` is applied
 * to each slot rather than to the pair.
 *
 * `formatScalar` is how a `lifecycle` bound gets rendered as a date while a
 * trait value is left exactly as stored: a trait's value is arbitrary
 * operator data that merely might look like a date, and reformatting it would
 * be this module inventing a type for it.
 */
function formatValue(value: unknown, formatScalar: (v: unknown) => string = String): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(v, formatScalar)).join(' and ')
  if (value === null) return 'null'
  return formatScalar(value)
}

/** A `lifecycle` value: always a datetime by the AST's own refine, so it is
 * rendered as one. A non-string scalar cannot be a reading and is left
 * alone. */
function asBound(value: unknown): string {
  return typeof value === 'string' ? formatBound(value) : String(value)
}

/**
 * A child rendered *inside* a group's join gets parenthesised when it is
 * itself a group, so precedence survives being flattened onto one line --
 * `a or (b and c)` is not the same segment as `a or b and c`. The top-level
 * call in `summarise` never adds this outer pair: a group passed directly
 * renders as its bare join, matching how the builder shows the tree it is
 * currently inside rather than a clause nested one level down.
 */
function part(node: FilterNode): string {
  return node.kind === 'group' ? `(${summarise(node)})` : summarise(node)
}

export function summarise(node: FilterNode): string {
  switch (node.kind) {
    case 'group':
      return node.children.map(part).join(` ${node.op} `)
    case 'not':
      return `not (${summarise(node.child)})`
    case 'trait':
      return `${node.key} ${operatorWord(node.operator)} ${formatValue(node.value)}`
    case 'context':
      return `${node.field} (${node.scope}) ${operatorWord(node.operator)} ${formatValue(node.value)}`
    case 'lifecycle':
      return `${node.field} ${operatorWord(node.operator)} ${formatValue(node.value, asBound)}`
    case 'behavior': {
      const clause = node.aggregate === 'count' ? 'count' : `${node.aggregate} of ${node.property}`
      const base = `${clause} of ${node.event} ${windowPhrase(node.window)} ${operatorWord(node.operator)} ${formatValue(node.value)}`
      if (!node.where || node.where.length === 0) return base
      const where = node.where
        .map((w) => `${w.property} ${operatorWord(w.operator)} ${formatValue(w.value)}`)
        .join(', ')
      return `${base} where ${where}`
    }
    default:
      return node satisfies never
  }
}
