import { WherePredicate } from '@lyraflow/core/segments/ast.js'

// The DEEP path, not the `@lyraflow/core` barrel. `WherePredicate` is used
// here as a VALUE (`.safeParse`), and the barrel re-exports `auth/password.ts`,
// which imports `node:util`. Pulling that into the browser bundle makes the
// admin app throw while evaluating, before React mounts --
// `build-output.test.ts` exists to catch exactly this, and `trends/params.ts`
// carries the same note for `INTERVALS`.

/**
 * Reads a `where` list out of one URL parameter.
 *
 * JSON in a query string is not pretty, and the alternative is worse: a
 * report screen's whole persistence IS the URL, so leaving predicates out of
 * it would mean a link that silently reproduces a DIFFERENT report from the
 * one whoever shared it was looking at.
 *
 * **Deliberately LENIENT about completeness.** This validated every element
 * against core's full `WherePredicate` and that was a real bug: the editor
 * adds a blank row (`{ property: '', operator: '=', value: '' }`) and
 * `property` is `z.string().min(1)`, so a newly-added row failed on the way
 * back out and "Add predicate" looked like a dead button. The control was
 * fine; this function ate its output.
 *
 * So the check is STRUCTURAL -- is this shaped like a predicate the editor
 * can render -- not "is this finished". Finishedness is a separate question,
 * answered by `countIncomplete` and reported on the screen, because a
 * half-built row must block the run rather than be dropped from it: dropping
 * it would quietly widen the report the operator thought they had built.
 *
 * Garbage is still refused. An array of numbers, strings or objects with no
 * operator degrades to no predicates, which is what a hand-edited or
 * truncated link should do.
 *
 * Shared by the retention grid and the trend chart. It was retention's alone
 * and was moved here rather than copied: two readers of one grammar drift at
 * the first operator added to either.
 */
export function looksLikePredicate(v: unknown): v is WherePredicate {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.operator !== 'string') return false
  if (o.source === 'attribute') return typeof o.attribute === 'string'
  return typeof o.property === 'string'
}

export function readWhere(raw: string | null): WherePredicate[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(looksLikePredicate)
  } catch {
    return []
  }
}

/**
 * The value to put in the URL, or `null` when there is nothing to say --
 * which the caller writes as a DELETE rather than as `where=[]`, keeping a
 * link that chose no filter free of a parameter saying so.
 */
export function writeWhere(list: readonly WherePredicate[]): string | null {
  return list.length === 0 ? null : JSON.stringify(list)
}

/**
 * Turns a stored report's raw `where` (`unknown[]` on the wire -- a row a
 * future build wrote can be read by this one) into predicates the editor can
 * render, with the SAME structural filter `readWhere` applies rather than a
 * second opinion about what "shaped like a predicate" means.
 *
 * Does not itself decide staleness: a row whose stored clauses no longer
 * parse comes back `stale: true` from the list endpoint. This just degrades
 * what it cannot render, exactly as a hand-edited URL would.
 */
export function whereFromStored(raw: unknown[]): WherePredicate[] {
  return raw.filter(looksLikePredicate)
}

/**
 * How many predicates are not yet finished.
 *
 * Checked against core's own schema, so "finished" means exactly "the server
 * would accept it" rather than a second opinion that could drift. The screen
 * disables Run and says the count: sending an incomplete predicate is a 400
 * the operator did not ask for, and silently dropping it runs a wider report
 * than they built.
 */
export function countIncomplete(list: readonly WherePredicate[]): number {
  return list.filter((w) => !WherePredicate.safeParse(w).success).length
}
