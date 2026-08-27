/**
 * Choosing an operator can change the SHAPE of a condition, not just one of
 * its fields -- so `{...node, operator}` is no longer a correct edit.
 *
 * Before the four new families (#193) every clause was `{operator, value}`
 * and the only reshaping needed was `between`'s second slot, which
 * `ValueInput` heals from an effect. Now:
 *
 *  - `is set` / `is true` carry NO `value` at all, so a spread leaves the old
 *    one behind -- a key the AST's clause union does not admit, which Zod
 *    strips silently on the way in. Silent is the problem: the operator's
 *    previous value survives invisibly in the editor's state and reappears
 *    the moment they pick a comparison operator again, so the row they saved
 *    and the row they see disagree.
 *  - `in the last` carries `{n, unit}`, which nothing else does.
 *
 * `WindowPicker` already learned this lesson for `Window`'s three variants
 * ("`{...value, kind: next}` would leave `n`/`unit` on an `absolute` node");
 * this is the same rule for the clause union, in one place rather than in
 * each of the five forms.
 */
import { OPERATOR_FAMILY } from '@lyraflow/core/segments/ast.js'
import type { Operator, RelativeWindow } from '@lyraflow/core/segments/ast.js'

/** What `in the last` starts at when an operator first picks it. */
export const DEFAULT_RELATIVE_WINDOW: RelativeWindow = { n: 7, unit: 'days' }

/**
 * A clause's value, or `undefined` for the families that carry none.
 *
 * `'value' in c` rather than a cast: the presence and boolean clauses have no
 * `value` key in the AST at all, so this is narrowing TypeScript already
 * knows how to do.
 */
export function clauseValueOf(node: { operator: Operator }): unknown {
  return 'value' in node ? node.value : undefined
}

/**
 * The node that results from choosing `operator`, with `value` reshaped into
 * that operator's family and no stale key left behind.
 *
 * Values are carried ACROSS families wherever they survive the trip, because
 * an operator refining `plan is pro` into `plan contains pro` has not asked
 * to retype the value. A tuple collapses to its first slot (the same rule
 * `ValueInput` applies when leaving `between`), a relative window has no
 * scalar reading and is dropped, and going the other way starts at
 * `DEFAULT_RELATIVE_WINDOW` rather than at an empty box the server would
 * refuse.
 *
 * ONE cast, here, rather than one per caller. The AST's predicates are
 * intersections of a target with a five-member clause union, and no signature
 * over that union can express "same target, different member" without
 * enumerating all five targets; the forms already cast at this boundary
 * (`onChange({...node, value} as Trait)`), so this consolidates five casts
 * into one that is tested directly.
 */
export function withOperator<T extends { operator: Operator }>(node: T, operator: Operator): T {
  const family = OPERATOR_FAMILY[operator]
  const previous = clauseValueOf(node)
  // Rebuilt without `value` rather than spread-and-deleted: the key must be
  // ABSENT, not present holding `undefined`. The two are the same object to
  // `===` but not to `JSON.stringify`, and this tree is serialised on save.
  const rest = {
    ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'value')),
    operator,
  } as Record<string, unknown>

  if (family === 'set' || family === 'boolean') return rest as unknown as T

  if (family === 'relative') {
    const kept = isRelativeWindow(previous) ? previous : DEFAULT_RELATIVE_WINDOW
    return { ...rest, value: kept } as unknown as T
  }

  // A relative window has no scalar reading, so it is dropped rather than
  // stringified into `[object Object]`.
  const scalar = isRelativeWindow(previous)
    ? ''
    : Array.isArray(previous)
      ? (previous[0] ?? '')
      : (previous ?? '')

  if (family === 'text') return { ...rest, value: String(scalar ?? '') } as unknown as T

  // Comparison. `between`'s second slot is left to `ValueInput`'s own healing
  // effect, which is where that rule already lives.
  return { ...rest, value: scalar } as unknown as T
}

function isRelativeWindow(v: unknown): v is RelativeWindow {
  return typeof v === 'object' && v !== null && 'n' in v && 'unit' in v
}
