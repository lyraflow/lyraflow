import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { describe, expect, it } from 'vitest'
import { normaliseRoot } from './TreeEditor.js'
import {
  astIssuePath,
  completeness,
  costWarningPath,
  incompleteAt,
  warningsAt,
} from './warnings.js'

describe('costWarningPath', () => {
  it('extracts a single top-level index', () => {
    expect(costWarningPath('filter.children[0]')).toEqual([0])
  })

  it('extracts every index through nested groups, in order', () => {
    expect(costWarningPath('filter.children[0].children[1]')).toEqual([0, 1])
  })

  it('skips a bare .child segment from a `not` wrapper, consuming no index', () => {
    // validate.ts's walk emits `.child` (no brackets, no digit) descending
    // through a `not` -- this must resolve identically to the unwrapped
    // path, matching tree.ts's own rule that `not` never consumes a path
    // segment.
    expect(costWarningPath('filter.children[0].child')).toEqual([0])
    expect(costWarningPath('filter.child.children[2]')).toEqual([2])
  })

  it('returns an empty path for the root itself', () => {
    expect(costWarningPath('filter')).toEqual([])
  })
})

describe('warningsAt', () => {
  const warnings = [
    { path: 'filter.children[0]', reason: 'top-level' },
    { path: 'filter.children[0].children[1]', reason: 'nested' },
    { path: 'filter.children[1]', reason: 'sibling' },
  ]

  it('matches only the warning addressed to exactly this path', () => {
    expect(warningsAt(warnings, [0])).toEqual([{ path: 'filter.children[0]', reason: 'top-level' }])
  })

  it('does not match a descendant warning against its ancestor group', () => {
    // Invented mutation check: dropping the length comparison (matching on
    // a shared PREFIX rather than an exact path) would make this pass too --
    // this pins that a group must never show a child's own warning as if it
    // were the group's.
    const atGroup = warningsAt(warnings, [0])
    expect(atGroup).not.toContainEqual({
      path: 'filter.children[0].children[1]',
      reason: 'nested',
    })
  })

  it('matches a deeper path exactly', () => {
    expect(warningsAt(warnings, [0, 1])).toEqual([
      { path: 'filter.children[0].children[1]', reason: 'nested' },
    ])
  })

  it('returns nothing for a path with no warning', () => {
    expect(warningsAt(warnings, [5])).toEqual([])
  })
})

// --- The seam this module sits in. `warningsAt` matches on an EXACT path
// length, which is correct -- a group must not show its child's warning as
// its own -- but it makes the module unforgiving of a caller that computes
// warnings against a different tree than the one it renders. That is what
// happened: the editor wrapped a non-group root in a one-child group to
// render it, while the screen computed `costWarnings` against the un-wrapped
// tree, so every warning path was one segment short of the row it named and
// every single one was silently dropped. These assert the arithmetic
// directly, on both sides of the fix, so the seam cannot reopen unnoticed
// behind a passing screen test.

describe('warningsAt across a normalised root', () => {
  const behaviour: FilterNode = {
    kind: 'behavior',
    event: 'purchase',
    aggregate: 'count',
    window: { kind: 'ever' },
    operator: '>=',
    value: 1,
  }

  it('drops every warning when the paths are computed one level above the rendered rows', () => {
    // The defect, stated as arithmetic. A bare-leaf root yields the path
    // `filter` -- the empty editor path -- while the row the editor renders
    // for that same leaf is at `[0]`.
    const shifted = costWarnings({ ast_version: AST_VERSION, filter: behaviour })
    expect(shifted).toHaveLength(1)
    expect(shifted[0]?.path).toBe('filter')
    expect(costWarningPath('filter')).toEqual([])
    expect(warningsAt(shifted, [0])).toEqual([])
  })

  it('lands the warning on the rendered row when both come from the normalised tree', () => {
    const aligned = costWarnings({
      ast_version: AST_VERSION,
      filter: normaliseRoot(behaviour),
    })
    expect(aligned[0]?.path).toBe('filter.children[0]')
    expect(warningsAt(aligned, [0])).toHaveLength(1)
    // Still not the root's own path -- the exact-length rule is intact.
    expect(warningsAt(aligned, [])).toEqual([])
  })

  it('lands a not-wrapped leaf warning on the same row as the bare leaf would', () => {
    // `not` consumes no editor path segment, so both shapes address `[0]`.
    const aligned = costWarnings({
      ast_version: AST_VERSION,
      filter: normaliseRoot({ kind: 'not', child: behaviour }),
    })
    expect(aligned[0]?.path).toBe('filter.children[0].child')
    expect(warningsAt(aligned, [0])).toHaveLength(1)
  })
})

// --- The other path format that has to land on a row: a Zod issue's own
// `path` array. `costWarningPath` above bridges `validate.ts`'s dotted
// strings; `astIssuePath` bridges these. Both have to agree with `tree.ts`'s
// numeric paths or a message lands on the wrong condition, which is worse
// than no message at all.

describe('astIssuePath', () => {
  it('extracts a child index only when the segment before it is `children`', () => {
    expect(astIssuePath(['children', 1, 'key'])).toEqual([1])
    expect(astIssuePath(['children', 0, 'children', 2, 'event'])).toEqual([0, 2])
  })

  it('takes no index from `where`, `value` or `window`, which address no node', () => {
    // The mutation this rules out: "every number in the path is a child
    // index". A `where` predicate's index and a `between` value's index are
    // both numbers, and both would then push a row that does not exist --
    // silently moving the message to a sibling, or to nowhere.
    expect(astIssuePath(['children', 0, 'where', 2, 'property'])).toEqual([0])
    expect(astIssuePath(['children', 3, 'value', 1])).toEqual([3])
    expect(astIssuePath(['children', 1, 'window', 'from'])).toEqual([1])
  })

  it('consumes nothing for a `child` segment from a `not` wrapper', () => {
    // Same rule as `costWarningPath`'s bare `.child`, and the same reason:
    // `tree.ts` never lets a `not` consume a path segment, so a negated
    // leaf must resolve to the row the unwrapped leaf would.
    expect(astIssuePath(['children', 0, 'child', 'key'])).toEqual([0])
    expect(astIssuePath(['children', 2, 'children', 0, 'child', 'event'])).toEqual([2, 0])
  })

  it("resolves a group's own failure to the group, not to a child it does not have", () => {
    expect(astIssuePath(['children'])).toEqual([])
    expect(astIssuePath(['children', 1, 'children'])).toEqual([1])
  })

  it('resolves a bare-leaf root to the empty path', () => {
    expect(astIssuePath(['key'])).toEqual([])
  })
})

describe('completeness', () => {
  const complete: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

  function root(...children: FilterNode[]): FilterNode {
    return { kind: 'group', op: 'and', children }
  }

  it('accepts a tree every field of which is filled in', () => {
    expect(completeness(root(complete))).toEqual({ complete: true, incomplete: [] })
  })

  // Three DIFFERENT incomplete shapes, so the check cannot be accidentally
  // trait-specific -- the first field a fresh condition of each kind leaves
  // blank is a different field in a different position of a different
  // schema.

  it('catches a trait whose key has not been filled in, at its own nested path', () => {
    const tree = root(complete, root({ kind: 'trait', key: '', operator: '=', value: '' }))
    const { complete: ok, incomplete } = completeness(tree)
    expect(ok).toBe(false)
    expect(incomplete).toEqual([[1, 0]])
  })

  it('catches a behaviour whose event has not been named', () => {
    const tree = root(complete, {
      kind: 'behavior',
      event: '',
      aggregate: 'count',
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 1,
    })
    expect(completeness(tree)).toEqual({ complete: false, incomplete: [[1]] })
  })

  it('catches an absolute window with neither bound filled in, and says so once', () => {
    // Two issues (`from` and `to`) on ONE node, and the list names that
    // node once. `incompleteAt` is a boolean, so today a duplicate would be
    // invisible on screen -- which is exactly why it is pinned HERE rather
    // than left to a render test: `incomplete` is a list of ROWS, and the
    // first caller that counts it, or renders one message per entry, would
    // otherwise inherit a silent duplicate.
    const tree = root({
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      window: { kind: 'absolute', from: '', to: '' },
      operator: '>=',
      value: 1,
    })
    expect(completeness(tree)).toEqual({ complete: false, incomplete: [[0]] })
  })

  it('keeps a `where` predicate index out of the row path, on a real parse', () => {
    // The `astIssuePath` case above, stated against Zod's own output rather
    // than a hand-written path array -- so a change to how the schema
    // nests `where` cannot leave that unit test passing against a shape
    // core no longer produces. Reachable from the UI: `WherePredicates`
    // adds a predicate whose property starts empty.
    const tree = root(complete, {
      kind: 'behavior',
      event: 'checkout',
      where: [{ property: '', operator: '=', value: '' }],
      aggregate: 'count',
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 1,
    })
    // `[1]`, the behaviour's own row -- never `[1, 0]`, which is a child
    // the behaviour does not have.
    expect(completeness(tree).incomplete).toEqual([[1]])
  })

  it('lands an incomplete NEGATED leaf on the same row as the bare leaf would', () => {
    const bare = root(complete, { kind: 'trait', key: '', operator: '=', value: '' })
    const negated = root(complete, {
      kind: 'not',
      child: { kind: 'trait', key: '', operator: '=', value: '' },
    })
    expect(completeness(negated).incomplete).toEqual(completeness(bare).incomplete)
    expect(completeness(negated).incomplete).toEqual([[1]])
  })

  it('names every incomplete row, not only the first', () => {
    const tree = root({ kind: 'trait', key: '', operator: '=', value: '' }, complete, {
      kind: 'trait',
      key: '',
      operator: '=',
      value: '',
    })
    expect(completeness(tree).incomplete).toEqual([[0], [2]])
  })
})

describe('incompleteAt', () => {
  const incomplete = [[0], [1, 2]]

  it('matches only the path addressed to exactly this node', () => {
    expect(incompleteAt(incomplete, [0])).toBe(true)
    expect(incompleteAt(incomplete, [1, 2])).toBe(true)
  })

  it('does not match a sibling, an ancestor or a descendant', () => {
    // The same exact-length rule `warningsAt` matches on. A prefix match
    // would show a child's "not finished" on the group above it; a "some
    // path exists" check would show it on every row in the tree.
    expect(incompleteAt(incomplete, [1])).toBe(false)
    expect(incompleteAt(incomplete, [2])).toBe(false)
    expect(incompleteAt(incomplete, [0, 0])).toBe(false)
    expect(incompleteAt(incomplete, [])).toBe(false)
  })

  it('matches nothing against an empty list', () => {
    expect(incompleteAt([], [0])).toBe(false)
  })
})
