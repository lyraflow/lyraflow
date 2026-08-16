import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { describe, expect, it } from 'vitest'
import { normaliseRoot } from './TreeEditor.js'
import { costWarningPath, warningsAt } from './warnings.js'

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
