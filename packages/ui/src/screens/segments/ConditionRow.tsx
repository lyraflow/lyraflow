import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { Button } from '../../components/ui/button.js'
import { summarise } from './summarise.js'

/**
 * The placeholder leaf renderer. Tasks 5 and 6 replace the body below with
 * real per-kind forms (`TraitForm`, `ContextForm`, `LifecycleForm`,
 * `BehaviourForm`), switched on `node.kind` -- unwrapping a `not` first, the
 * same way `summarise` already does, so a negated leaf still shows what it
 * negates rather than just "not". Until then this renders the one-line
 * summary every row already has for free.
 *
 * This component's actual job for Task 4 is the STRUCTURE around that body:
 * the `condition-<path>` testid Tasks 5/6 must keep (ruling 2, both their
 * briefs), and Remove/Negate, which this component NEVER computes a path
 * for itself -- `path` and the three callbacks all come from the caller
 * (`GroupCard`), addressed to this node's own position. That is what keeps
 * "negate the wrong sibling" and "negate the parent instead of the node"
 * unreachable from here: there is no tree, no root, and no `path` maths in
 * this file at all, only the address it was handed.
 *
 * `onChange` replaces this node's own value wholesale (`replaceAt(root,
 * path, next)`, wired by `GroupCard`) -- unused by the placeholder body,
 * which only reads `node`, but required by the signature Tasks 5 and 6
 * build on (`<ConditionRow node path onChange onRemove onNegate />`).
 */
export function ConditionRow(props: {
  node: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
  onRemove: () => void
  onNegate: () => void
}) {
  const { node, path, onRemove, onNegate } = props
  // Whether THIS node is currently negated -- purely presentational here
  // (drives `aria-pressed`); `onNegate` toggles it either way regardless of
  // the current state, so the accessible name stays "Negate" rather than
  // flipping to "Un-negate" and breaking a test (or a person) that looked
  // for the word "negate" after a toggle.
  const negated = node.kind === 'not'
  const testId = `condition-${path.join('-')}`

  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
    >
      <span className="text-sm text-foreground">{summarise(node)}</span>
      <div className="flex gap-1">
        <Button type="button" variant="outline" size="sm" aria-pressed={negated} onClick={onNegate}>
          Negate
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  )
}
