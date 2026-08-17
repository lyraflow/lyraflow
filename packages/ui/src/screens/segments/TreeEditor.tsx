import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import type { ApiClient } from '../../api/client.js'
import { GroupCard } from './GroupCard.js'

/**
 * `SegmentQuery.filter` is the whole `FilterNode` union, so a segment
 * authored by the CLI can legally have a bare `trait`, `context`,
 * `lifecycle`, `behavior` or `not` at its root -- rendering that straight
 * through `GroupCard` would throw, since `GroupCard` addresses a group.
 *
 * Wraps a non-group root in a one-child `and` group -- semantically
 * identical, since a one-child `and` compiles the same as its bare child --
 * rather than teaching every level of the recursion (`GroupCard`,
 * `ConditionRow`) to also cope with a root that might not be a group.
 *
 * EXPORTED, and applied by the OWNER of the tree (`SegmentBuilder`, at the
 * one point a tree enters its state), never silently inside `TreeEditor`.
 * That is not a stylistic preference. While this ran inside `TreeEditor`,
 * the editor rendered a tree one level deeper than the one its caller held,
 * so every `costWarnings` path computed against the caller's tree was one
 * segment shorter than the `ConditionRow` it named and `warningsAt`'s exact
 * match dropped it -- a bare-leaf-rooted segment showed "this segment is
 * expensive" and no indication of which condition. Two trees, reconciled
 * nowhere. `TreeEditor` now takes a `Group`, so the type system forbids the
 * seam from reopening: a caller that has not normalised cannot call it.
 *
 * Idempotent -- normalising an already-group root returns it unchanged --
 * so applying it at every entry point costs nothing and can never
 * double-wrap.
 *
 * Deliberately NOT in `tree.ts`: that module stays pure over whatever shape
 * it is given (its own doc comment says so explicitly). This is a decision
 * about how a tree is PRESENTED for editing, not a tree edit itself.
 */
export function normaliseRoot(value: FilterNode): Group {
  return value.kind === 'group' ? value : { kind: 'group', op: 'and', children: [value] }
}

/**
 * The root of the recursive tree editor: renders the `Group` it is handed
 * through `GroupCard` at the empty path. Every mutation from here down is
 * owned by `GroupCard`/`ConditionRow`, which call `tree.ts` functions
 * against the FULL root and hand the whole new root up through `onChange`
 * -- this component itself never calls a `tree.ts` function directly, and
 * never alters the tree it was given.
 *
 * `onChange` always receives a `group`-rooted `FilterNode`: every `tree.ts`
 * function preserves the `kind` of whatever it is given at the root (only
 * the addressed node, at some path length >= 1 from here, ever changes
 * kind), so the root stays a group through every subsequent edit -- there
 * is no un-wrapping step, because the wrapped shape and the bare one
 * compile identically.
 *
 * `client`/`projectId`/`onUnauthorized` are passed straight through to
 * `GroupCard` -- this component owns no state and makes no requests of its
 * own; they exist only so a `behavior` leaf, at whatever depth, can reach
 * `BehaviourForm`.
 *
 * `warnings` is likewise passed straight through, unfiltered --
 * `SegmentBuilder` computes the whole tree's `costWarnings()` once and hands
 * it down; only `ConditionRow`, at whatever depth, picks out the ones
 * addressed to its own path. Defaults to `[]`.
 */
export function TreeEditor(props: {
  /** A `Group`, not the whole `FilterNode` union -- the caller normalises
   * (`normaliseRoot`, above) and keeps the normalised tree, so the tree
   * warnings are computed from and the tree rendered here are the same
   * object. */
  value: Group
  onChange: (next: FilterNode) => void
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
  warnings?: CostWarning[]
  /** Passed straight through, unfiltered, exactly like `warnings` --
   * `SegmentBuilder` computes the whole tree's `completeness()` once and
   * hands the incomplete paths down; only `ConditionRow`, at whatever
   * depth, picks out whether one names its own row. Defaults to `[]`. */
  incomplete?: number[][]
}) {
  const {
    value,
    onChange,
    client,
    projectId,
    onUnauthorized,
    warnings = [],
    incomplete = [],
  } = props
  return (
    <GroupCard
      root={value}
      path={[]}
      onChange={onChange}
      client={client}
      projectId={projectId}
      onUnauthorized={onUnauthorized}
      warnings={warnings}
      incomplete={incomplete}
    />
  )
}
