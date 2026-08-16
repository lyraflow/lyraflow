import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import { GroupCard } from './GroupCard.js'

/**
 * Controller correction 1 (binding): `SegmentQuery.filter` is the whole
 * `FilterNode` union, so a segment authored by the CLI can legally have a
 * bare `trait`, `context`, `lifecycle`, `behavior` or `not` at its root --
 * this plan's own Step 3 text said "renders the root through GroupCard",
 * which assumes a group and would throw the instant such a segment opened
 * (`GroupCard` unconditionally casts to `Group`).
 *
 * Wraps a non-group root in a one-child `and` group -- semantically
 * identical, since a one-child `and` compiles the same as its bare child --
 * rather than teaching every level of the recursion (`GroupCard`,
 * `ConditionRow`) to also cope with a root that might not be a group. Safe
 * to do silently, per the correction: merely opening a segment never writes
 * it back, so this reaches the server only if the operator makes an actual
 * edit and saves it.
 *
 * Deliberately NOT in `tree.ts`: that module stays pure over whatever shape
 * it is given (its own doc comment says so explicitly). This is a decision
 * about how a tree is PRESENTED for editing, made at the one point a tree
 * enters this editor, not a tree edit itself.
 */
function normalise(value: FilterNode): Group {
  return value.kind === 'group' ? value : { kind: 'group', op: 'and', children: [value] }
}

/**
 * The root of the recursive tree editor: normalises whatever `value` is
 * handed, then renders it through `GroupCard` at the empty path. Every
 * mutation from here down is owned by `GroupCard`/`ConditionRow`, which
 * call `tree.ts` functions against the FULL (normalised) root and hand the
 * whole new root up through `onChange` -- this component itself never
 * calls a `tree.ts` function directly.
 *
 * `onChange` always receives a `group`-rooted `FilterNode`: every `tree.ts`
 * function preserves the `kind` of whatever it is given at the root (only
 * the addressed node, at some path length >= 1 from here, ever changes
 * kind), so once normalised the root stays a group through every
 * subsequent edit -- there is no un-wrapping step, because the wrapped
 * shape and the bare one compile identically.
 */
export function TreeEditor(props: { value: FilterNode; onChange: (next: FilterNode) => void }) {
  const { value, onChange } = props
  const root = normalise(value)
  return <GroupCard root={root} path={[]} onChange={onChange} />
}
