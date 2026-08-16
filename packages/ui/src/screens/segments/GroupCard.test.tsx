import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { GroupCard } from './GroupCard.js'

const client = {} as unknown as ApiClient
const projectId = 1

const trait = (key: string): FilterNode => ({ kind: 'trait', key, operator: '=', value: 'x' })
const behavior = (event: string): FilterNode => ({
  kind: 'behavior',
  event,
  aggregate: 'count',
  window: { kind: 'last', n: 1, unit: 'days' },
  operator: '>=',
  value: 1,
})

/** A flat root with `n` trait leaves -- `countNodes` = `n + 1` (the root
 * group itself counts too, `tree.ts`'s own doc comment on `countNodes`). */
function flatRoot(n: number): Group {
  return { kind: 'group', op: 'and', children: Array.from({ length: n }, (_, i) => trait(`k${i}`)) }
}

function flatBehaviorRoot(n: number): Group {
  return {
    kind: 'group',
    op: 'and',
    children: Array.from({ length: n }, (_, i) => behavior(`e${i}`)),
  }
}

/** A chain of single-child groups, `depth` levels deep (root at depth 0),
 * bottoming out in one trait leaf -- the deepest legal shape for a given
 * `depth`: the leaf itself sits at `depth`, which must stay `< MAX_TREE_DEPTH`
 * for the whole tree to be legal at all. */
function chain(depth: number): Group {
  let node: FilterNode = trait('leaf')
  for (let d = depth; d > 0; d--) {
    node = { kind: 'group', op: 'and', children: [node] }
  }
  return node as Group
}

function pathToDeepestGroup(root: Group): number[] {
  const path: number[] = []
  let node: FilterNode = root
  while (
    node.kind === 'group' &&
    node.children.length === 1 &&
    node.children[0]?.kind === 'group'
  ) {
    path.push(0)
    node = node.children[0]
  }
  return path
}

describe('GroupCard -- the three server-side caps', () => {
  // --- MAX_TREE_NODES: global, so checked identically at any depth -----

  // Rendering MAX_TREE_NODES - 1 real leaves (each a full TraitForm) is
  // slow in jsdom -- comfortably under 5s in isolation but occasionally over
  // the default 5000ms budget under this box's own documented contention. A
  // longer per-test timeout, not a smaller fixture: the fixture size IS the
  // thing under test (the exact boundary value), here and below.
  it('disables Add condition and Add group at the node cap, and says the limit', () => {
    const root = flatRoot(MAX_TREE_NODES - 1) // countNodes === MAX_TREE_NODES exactly
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    const add = screen.getByRole('button', { name: /^add condition$/i })
    const addGroup = screen.getByRole('button', { name: /^add group$/i })
    expect(add).toBeDisabled()
    expect(addGroup).toBeDisabled()
    expect(screen.getByText(new RegExp(String(MAX_TREE_NODES)))).toBeInTheDocument()
  }, 15000)

  it('one below the node cap: Add condition (costs 1 node) is enabled, Add group (costs 2) is not', () => {
    // The off-by-one this task's own math has to get right: at
    // MAX_TREE_NODES - 1 total nodes, one more leaf still fits (reaches
    // the cap exactly, which validateTree allows) but a group -- which
    // costs itself PLUS its seeded child, `newGroup`'s own doc comment --
    // would not.
    const root = flatRoot(MAX_TREE_NODES - 2) // countNodes === MAX_TREE_NODES - 1
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    expect(screen.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^add group$/i })).toBeDisabled()
  }, 15000)

  it('clicking a node-capped Add condition never calls onChange', async () => {
    const onChange = vi.fn()
    const root = flatRoot(MAX_TREE_NODES - 1)
    render(
      <GroupCard root={root} path={[]} onChange={onChange} client={client} projectId={projectId} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^add condition$/i }))
    expect(onChange).not.toHaveBeenCalled()
  }, 15000)

  // --- MAX_TREE_DEPTH: local to the group's own position ----------------

  it('disables Add condition and Add group on a group whose own depth is at the cap, and says so', () => {
    // A group at depth MAX_TREE_DEPTH - 1 (9): a new LEAF from "Add
    // condition" would sit at depth 10, which validateTree's own
    // `depth >= MAX_TREE_DEPTH` check refuses. Built directly at this
    // depth rather than reached by clicking through, since a real group
    // this deep with a legal child could never itself be constructed by
    // the builder (that child would already be illegal) -- this pins the
    // DISABLE logic against the boundary value itself, however the tree
    // came to be there (e.g. a CLI-authored segment already at the edge).
    const deepGroup: Group = { kind: 'group', op: 'and', children: [trait('leaf')] }
    const path = Array.from({ length: MAX_TREE_DEPTH - 1 }, () => 0)
    let root: FilterNode = deepGroup
    for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) {
      root = { kind: 'group', op: 'and', children: [root] }
    }
    render(
      <GroupCard
        root={root}
        path={path}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const testId = `group-${path.join('-')}`
    const card = within(screen.getByTestId(testId))
    expect(card.getByRole('button', { name: /^add condition$/i })).toBeDisabled()
    expect(card.getByRole('button', { name: /^add group$/i })).toBeDisabled()
    expect(card.getByText(new RegExp(String(MAX_TREE_DEPTH)))).toBeInTheDocument()
  })

  it('one level shallower: Add condition (adds 1 level) is enabled, Add group (adds 2) is not', () => {
    // A group at depth MAX_TREE_DEPTH - 2 (8): "Add condition" puts a leaf
    // at depth 9 -- the deepest LEGAL node overall -- so it must stay
    // enabled. "Add group" puts its own new group at depth 9 AND that
    // group's seeded child at depth 10, which is illegal, so it must not.
    const root = chain(MAX_TREE_DEPTH - 1)
    const path = pathToDeepestGroup(root)
    expect(path).toHaveLength(MAX_TREE_DEPTH - 2)
    render(
      <GroupCard
        root={root}
        path={path}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const testId = `group-${path.join('-')}`
    const card = within(screen.getByTestId(testId))
    expect(card.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(card.getByRole('button', { name: /^add group$/i })).toBeDisabled()
  })

  it("a shallow group's own Add controls are unaffected by a DIFFERENT branch being at the depth cap", () => {
    // Depth is LOCAL: a group two levels down one branch must not be
    // capped merely because some other, unrelated branch of the same tree
    // happens to run all the way to MAX_TREE_DEPTH.
    const deepBranch = chain(MAX_TREE_DEPTH - 2)
    const root: Group = { kind: 'group', op: 'and', children: [trait('shallow'), deepBranch] }
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    // Scoped to the ROOT's own `-add` testid -- the deep branch's own
    // nested groups each render their OWN "Add condition"/"Add group"
    // too, which makes an unscoped query ambiguous the moment this fixture
    // has more than one group in it.
    const rootAdd = within(screen.getByTestId('group--add'))
    expect(rootAdd.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(rootAdd.getByRole('button', { name: /^add group$/i })).toBeEnabled()
  })

  // --- MAX_BEHAVIOR_NODES: global, and (today) blocks a control that ----
  // never itself creates a behaviour -- see the Task 6 report for why.

  it('disables Add condition and Add group once the tree already has MAX_BEHAVIOR_NODES behaviours', () => {
    const root = flatBehaviorRoot(MAX_BEHAVIOR_NODES)
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    expect(screen.getByRole('button', { name: /^add condition$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^add group$/i })).toBeDisabled()
    expect(screen.getByText(new RegExp(String(MAX_BEHAVIOR_NODES)))).toBeInTheDocument()
  })

  it('one behaviour below the cap: Add condition is enabled', () => {
    const root = flatBehaviorRoot(MAX_BEHAVIOR_NODES - 1)
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    expect(screen.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
  })

  // --- None of this interferes with the pre-existing negated-group disable

  it('a negated group stays disabled for its own reason even when no cap is close', () => {
    const root: Group = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'not', child: { kind: 'group', op: 'and', children: [trait('a')] } }],
    }
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    const nested = within(screen.getByTestId('group-0'))
    expect(nested.getByRole('button', { name: /^add condition$/i })).toBeDisabled()
    // No cap message renders here -- this group is small and shallow, so
    // the disable is entirely the pre-existing negation rule, not a cap.
    expect(nested.queryByText(new RegExp(String(MAX_TREE_NODES)))).toBeNull()
  })
})
