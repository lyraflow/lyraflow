import { describe, expect, it } from 'vitest'
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
