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
 * Warnings whose path resolves to exactly this node's own address -- never a
 * prefix or a descendant match, so a group carrying a warning on one of its
 * children does not also show that warning on the group itself.
 */
export function warningsAt<W extends { path: string }>(warnings: W[], path: number[]): W[] {
  return warnings.filter((w) => {
    const wp = costWarningPath(w.path)
    return wp.length === path.length && wp.every((n, i) => n === path[i])
  })
}
