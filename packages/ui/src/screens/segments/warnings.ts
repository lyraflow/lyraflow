import { FilterNode as FilterNodeSchema } from '@lyraflow/core/segments/ast.js'
import type { FilterNode } from '@lyraflow/core/segments/ast.js'

/**
 * Bridges `costWarnings`' own path format (`filter.children[0].children[1]`,
 * `validate.ts`'s `walk`) to the numeric child-index path this editor
 * addresses nodes by (`tree.ts`'s own doc comment: `number[]`, `not` never
 * consuming a segment) -- the same path `GroupCard`/`ConditionRow` join with
 * `-` to build `condition-<path>`/`group-<path>` testids.
 *
 * Only `children[N]` segments carry an index. `validate.ts`'s `walk` also
 * emits a bare `.child` when it descends through a `not` (no bracket, no
 * digit) -- which this regex simply never matches, exactly mirroring how
 * `tree.ts` itself never lets a `not` consume a path segment. A `not`
 * wrapping a `behavior` leaf therefore resolves to the SAME path as the
 * unwrapped leaf would, which is what keeps a warning landing on the right
 * `ConditionRow` regardless of whether the condition it names happens to be
 * negated.
 */
export function costWarningPath(path: string): number[] {
  return [...path.matchAll(/children\[(\d+)\]/g)].map((m) => Number(m[1]))
}

/**
 * "Addressed to exactly this node" -- an EXACT match, never a prefix and
 * never a descendant, so a group carrying something on one of its children
 * does not also show it as its own. One definition, shared by both things
 * in this module that address a node by path, so a cost warning and an
 * incompleteness message can never disagree about which row they belong to.
 */
function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/**
 * Warnings whose path resolves to exactly this node's own address -- see
 * `samePath`.
 */
export function warningsAt<W extends { path: string }>(warnings: W[], path: number[]): W[] {
  return warnings.filter((w) => samePath(costWarningPath(w.path), path))
}

/**
 * The same bridge as `costWarningPath`, for the OTHER path format that has
 * to land on a row: a Zod issue's own `path`, which is an array
 * (`['children', 1, 'window', 'from']`) rather than a dotted string.
 *
 * Same rule, and it has to be the same rule: a number counts as a child
 * index ONLY when the segment before it is literally `children`. Everything
 * else an issue can point through is a field name or an index into
 * something that is not the tree -- `where[2]`, a `between` value's
 * `value[1]`, `window.from` -- and none of those addresses a node. A `not`
 * contributes the segment `child`, which is not a number and so consumes
 * nothing, exactly as `tree.ts` never lets a `not` consume a path segment
 * and exactly as `costWarningPath` drops `validate.ts`'s bare `.child`. A
 * negated leaf therefore resolves to the same row as the unwrapped leaf
 * would.
 *
 * A group's own failure (`children.min(1)`) yields `['children']` with no
 * index after it, which resolves to the GROUP's own path -- not to a child
 * it does not have.
 */
export function astIssuePath(issuePath: readonly (string | number)[]): number[] {
  const out: number[] = []
  for (let i = 0; i < issuePath.length; i++) {
    if (issuePath[i] !== 'children') continue
    const index = issuePath[i + 1]
    if (typeof index !== 'number') continue
    out.push(index)
    i += 1
  }
  return out
}

/**
 * Whether a tree is STORABLE, and which rows are not finished yet.
 *
 * The convention this exists to serve: an empty field means "not filled in
 * yet". The AST is a STORAGE schema, and a half-typed condition is a
 * legitimate editing state and an illegitimate storage state -- so the
 * builder may hold an incomplete draft, Save is refused while it does, and
 * the incomplete condition says so on its own row. Conflating the two
 * forces either invented data (seeding a trait's key with a plausible
 * example the operator never chose) or a tree the server will refuse from a
 * form the UI let them build.
 *
 * `complete` comes from the REAL schema in core -- one `safeParse` of the
 * whole tree, never a hand-written notion of "filled in". A second
 * definition of validity is exactly what would drift from the one the
 * server enforces, and the field that drifted would be one nobody thought
 * about (a `count` aggregate that must carry no property; a `last` window
 * capped at 3650; a lifecycle bound that has to parse as a datetime).
 *
 * `incomplete` is the same parse's issues mapped onto editor paths, so the
 * message lands on the row that is incomplete rather than in a page-level
 * banner -- the same reason a cost warning does (`warningsAt` above): "the
 * `import_started` condition scans all history" is actionable read against
 * the row it names, and the same sentence above forty conditions is not.
 * Deduplicated, because one row can raise several issues at once (an
 * `absolute` window with neither bound filled in raises two) and the row
 * has one thing to say.
 */
export interface Completeness {
  /** True when the whole tree parses against `ast.ts`'s own `FilterNode`. */
  complete: boolean
  /** Editor paths (`tree.ts`'s `number[]`) of every node an issue names. */
  incomplete: number[][]
}

export function completeness(root: FilterNode): Completeness {
  const parsed = FilterNodeSchema.safeParse(root)
  if (parsed.success) return { complete: true, incomplete: [] }
  const seen = new Set<string>()
  const incomplete: number[][] = []
  for (const issue of parsed.error.issues) {
    const path = astIssuePath(issue.path)
    const key = path.join('-')
    if (seen.has(key)) continue
    seen.add(key)
    incomplete.push(path)
  }
  return { complete: false, incomplete }
}

/** Whether one of `incomplete` is addressed to exactly this node -- see
 * `samePath`, which is the same rule `warningsAt` matches on. */
export function incompleteAt(incomplete: number[][], path: number[]): boolean {
  return incomplete.some((p) => samePath(p, path))
}
