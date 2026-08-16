import { describe, expect, it } from 'vitest'
import {
  countBehaviours,
  countNodes,
  insertAt,
  maxDepth,
  negateAt,
  nodeAt,
  removeAt,
  replaceAt,
} from './tree.js'

const trait = (key: string) => ({ kind: 'trait', key, operator: '=', value: 'x' }) as const
const group = (...children: unknown[]) => ({ kind: 'group', op: 'and', children }) as const

describe('tree edits are pure', () => {
  it('does not mutate the input root', () => {
    const root = group(trait('a'))
    const before = JSON.stringify(root)
    insertAt(root as never, [], trait('b') as never)
    expect(JSON.stringify(root)).toBe(before)
  })

  it('inserts at the end of the addressed group', () => {
    const root = group(trait('a'))
    const next = insertAt(root as never, [], trait('b') as never) as never as typeof root
    expect(next.children).toHaveLength(2)
    expect((next.children[1] as { key: string }).key).toBe('b')
  })

  it('removes only the addressed child, leaving its siblings in order', () => {
    const root = group(trait('a'), trait('b'), trait('c'))
    const next = removeAt(root as never, [1]) as never as typeof root
    expect((next.children as { key: string }[]).map((c) => c.key)).toEqual(['a', 'c'])
  })

  it('negates by wrapping, and un-negates by unwrapping the same node', () => {
    const root = group(trait('a'))
    const negated = negateAt(root as never, [0]) as never as typeof root
    expect((negated.children[0] as { kind: string }).kind).toBe('not')
    const back = negateAt(negated as never, [0]) as never as typeof root
    expect(back).toEqual(root)
  })

  it('addresses a node through a not wrapper by the same path', () => {
    // A `not` is a presentation toggle, not a level the operator navigates.
    const root = group({ kind: 'not', child: trait('a') })
    expect((nodeAt(root as never, [0]) as { kind: string }).kind).toBe('not')
  })

  it('counts nodes, depth and behaviours the way validateTree does', () => {
    const root = group(trait('a'), group(trait('b')))
    expect(countNodes(root as never)).toBe(4)
    expect(maxDepth(root as never)).toBe(2)
    expect(countBehaviours(root as never)).toBe(0)
  })

  // --- Mutations invented beyond the brief -------------------------------

  it('shares untouched subtrees by reference rather than deep-cloning', () => {
    // The brief is explicit that this must not deep-clone: sharing is what
    // keeps a 100-node tree cheap to re-render. A correct-but-cloning
    // implementation would pass every value-equality test above and still
    // violate this, so it needs its own assertion.
    const untouchedChild = trait('a')
    const root = group(untouchedChild, trait('b'), trait('c'))
    const afterInsert = insertAt(root as never, [], trait('d') as never) as never as typeof root
    expect(afterInsert.children[0]).toBe(untouchedChild)
    const afterRemove = removeAt(root as never, [1]) as never as typeof root
    expect(afterRemove.children[0]).toBe(untouchedChild)
  })

  it('inserts into and removes from a group nested below the root, leaving the sibling subtree untouched', () => {
    const nestedGroup = group(trait('b'))
    const root = group(trait('a'), nestedGroup)
    const inserted = insertAt(root as never, [1], trait('c') as never) as never as typeof root
    expect((inserted.children[1] as typeof root).children).toHaveLength(2)
    expect(((inserted.children[1] as typeof root).children[1] as { key: string }).key).toBe('c')
    // root.children[0] (the untouched sibling) is shared by reference.
    expect(inserted.children[0]).toBe(root.children[0])

    const removed = removeAt(inserted as never, [1, 1]) as never as typeof root
    expect((removed.children[1] as typeof root).children).toHaveLength(1)
    expect(((removed.children[1] as typeof root).children[0] as { key: string }).key).toBe('b')
  })

  it('negates a node nested two levels deep, rebuilding only the spine above it', () => {
    const untouchedSibling = trait('a')
    const root = group(untouchedSibling, group(trait('b'), trait('c')))
    const next = negateAt(root as never, [1, 0]) as never as typeof root
    const inner = next.children[1] as typeof root
    expect((inner.children[0] as { kind: string }).kind).toBe('not')
    expect((inner.children[0] as { child: { key: string } }).child.key).toBe('b')
    // The sibling of the group we descended into is untouched, by reference.
    expect(next.children[0]).toBe(untouchedSibling)
  })

  it('reaches and removes a node nested underneath a not wrapper, using the same indices the un-negated tree would', () => {
    // Proves the "a `not` never consumes a path segment" rule for removeAt,
    // not just for nodeAt: [0, 0] must reach into the group beneath the
    // `not`, transparently, to remove its only grandchild.
    const root = group({ kind: 'not', child: group(trait('a'), trait('b')) })
    const next = removeAt(root as never, [0, 0]) as never as typeof root
    const notNode = next.children[0] as { kind: string; child: typeof root }
    expect(notNode.kind).toBe('not')
    expect((notNode.child.children as { key: string }[]).map((c) => c.key)).toEqual(['b'])
  })

  it('reaches a node nested underneath a not wrapper for replaceAt, transparently', () => {
    const root = group({ kind: 'not', child: group(trait('a')) })
    const replacement = trait('z')
    const next = replaceAt(root as never, [0, 0], replacement as never) as never as typeof root
    const notNode = next.children[0] as { kind: string; child: typeof root }
    expect(notNode.kind).toBe('not')
    expect((notNode.child.children[0] as { key: string }).key).toBe('z')
  })

  it('does not mutate the input root for removeAt, replaceAt or negateAt', () => {
    const root = group(trait('a'), trait('b'))
    const before = JSON.stringify(root)
    removeAt(root as never, [0])
    replaceAt(root as never, [0], trait('z') as never)
    negateAt(root as never, [0])
    expect(JSON.stringify(root)).toBe(before)
  })

  it('nodeAt returns null for an out-of-range index rather than throwing', () => {
    const root = group(trait('a'))
    expect(nodeAt(root as never, [5])).toBeNull()
  })

  it('nodeAt returns the root itself for an empty path', () => {
    const root = group(trait('a'))
    expect(nodeAt(root as never, [])).toBe(root)
  })
})
