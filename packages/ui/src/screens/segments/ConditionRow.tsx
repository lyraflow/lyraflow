import type { Context, FilterNode, Lifecycle, Trait } from '@lyraflow/core/segments/ast.js'
import { Button } from '../../components/ui/button.js'
import { ContextForm } from './ContextForm.js'
import { LifecycleForm } from './LifecycleForm.js'
import { TraitForm } from './TraitForm.js'
import { summarise } from './summarise.js'

/**
 * The leaf renderer: dispatches on `node.kind` -- unwrapping a `not` first,
 * the same way `summarise` already does, so a negated leaf still shows the
 * real form for what it negates rather than falling back to plain text.
 * `trait`/`context`/`lifecycle` get their real per-kind forms (Task 5);
 * `behavior` (Task 6's `BehaviourForm`) still falls back to the one-line
 * `summarise` text below, same as every kind did before this task.
 *
 * This component's actual job, unchanged from Task 4, is the STRUCTURE
 * around whatever body renders: the `condition-<path>` testid the
 * recursion's own tests address nodes through at arbitrary depth (the
 * controller correction, both this task's brief and Task 4's), and
 * Remove/Negate, which this component NEVER computes a path for itself --
 * `path` and the three callbacks all come from the caller (`GroupCard`),
 * addressed to this node's own position. That is what keeps "negate the
 * wrong sibling" and "negate the parent instead of the node" unreachable
 * from here: there is no tree, no root, and no `path` maths in this file at
 * all, only the address it was handed.
 *
 * `onChange` replaces this node's own value wholesale (`replaceAt(root,
 * path, next)`, wired by `GroupCard`). A per-kind form's own `onChange`
 * only ever hands back the UNWRAPPED node it was given (a `Trait`, never a
 * `not`) -- `wrapLike` below re-applies this leaf's own negation before
 * forwarding to `props.onChange`, so a form component never has to know
 * whether the node it is editing is currently negated.
 */
function wrapLike(original: FilterNode, next: FilterNode): FilterNode {
  return original.kind === 'not' ? { kind: 'not', child: next } : next
}

export function ConditionRow(props: {
  node: FilterNode
  path: number[]
  onChange: (next: FilterNode) => void
  onRemove: () => void
  onNegate: () => void
}) {
  const { node, path, onChange, onRemove, onNegate } = props
  // Whether THIS node is currently negated -- drives `aria-pressed` AND
  // which node the per-kind form below actually edits (the one `node`
  // wraps, never the `not` itself). `onNegate` toggles it either way
  // regardless of the current state, so the accessible name stays "Negate"
  // rather than flipping to "Un-negate" and breaking a test (or a person)
  // that looked for the word "negate" after a toggle.
  const negated = node.kind === 'not'
  const inner = negated ? node.child : node
  const testId = `condition-${path.join('-')}`
  const handleChange = (next: FilterNode) => onChange(wrapLike(node, next))

  function body() {
    switch (inner.kind) {
      case 'trait':
        return <TraitForm id={testId} node={inner as Trait} onChange={handleChange} />
      case 'context':
        return <ContextForm id={testId} node={inner as Context} onChange={handleChange} />
      case 'lifecycle':
        return <LifecycleForm id={testId} node={inner as Lifecycle} onChange={handleChange} />
      default:
        // `behavior` (Task 6) and any other kind not yet given a real
        // form: the one-line summary every row had for free before this
        // task, computed on `node` (not `inner`) so a negated behaviour
        // still reads "not (...)" rather than dropping the negation from
        // view.
        return <span className="text-sm text-foreground">{summarise(node)}</span>
    }
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
    >
      {body()}
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
