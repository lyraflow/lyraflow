import type {
  Behavior,
  Context,
  FilterNode,
  Lifecycle,
  Trait,
} from '@lyraflow/core/segments/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import { AlertTriangle } from 'lucide-react'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { BehaviourForm } from './BehaviourForm.js'
import { ContextForm } from './ContextForm.js'
import { LifecycleForm } from './LifecycleForm.js'
import { TraitForm } from './TraitForm.js'
import { summarise } from './summarise.js'
import { warningsAt } from './warnings.js'

/**
 * The leaf renderer: dispatches on `node.kind` -- unwrapping a `not` first,
 * the same way `summarise` already does, so a negated leaf still shows the
 * real form for what it negates rather than falling back to plain text.
 * `trait`/`context`/`lifecycle` get their real per-kind forms (Task 5), and
 * `behavior` gets `BehaviourForm` (Task 6) -- every leaf kind the AST
 * defines now has one. The `default` branch below is defensive only: it
 * stays reachable in the TYPE system (nothing here asserts exhaustiveness),
 * so a leaf kind added to the AST later without a matching form here still
 * renders the one-line `summarise` text instead of nothing at all.
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
 *
 * Task 7: `warnings` is the FULL `costWarnings()` list for the whole tree,
 * not pre-filtered by the caller -- `warningsAt` (own doc comment,
 * `warnings.ts`) picks out only the ones addressed to THIS node's own
 * `path`, rendered inside this component's own testid wrapper rather than
 * in a page-level panel. That is the whole point: "the `import_started`
 * condition scans all history" is actionable read against the row it
 * names; the same sentence in a panel above 40 conditions is not. Defaults
 * to `[]` so every existing caller (every test in this file, `GroupCard`'s
 * own recursion before this task) keeps working unchanged.
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
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
  warnings?: CostWarning[]
}) {
  const {
    node,
    path,
    onChange,
    onRemove,
    onNegate,
    client,
    projectId,
    onUnauthorized,
    warnings = [],
  } = props
  const ownWarnings = warningsAt(warnings, path)
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
      case 'behavior':
        return (
          <BehaviourForm
            id={testId}
            node={inner as Behavior}
            client={client}
            projectId={projectId}
            onChange={handleChange}
            onUnauthorized={onUnauthorized}
          />
        )
      default:
        // Unreachable for any leaf kind the AST defines today -- every one
        // has a real form above. Kept as the one-line summary (computed on
        // `node`, not `inner`, so a negated leaf still reads "not (...)"
        // rather than dropping the negation from view) as a defensive
        // fallback for a future kind added here before it gets a form.
        return <span className="text-sm text-foreground">{summarise(node)}</span>
    }
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {body()}
        <div className="flex gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={negated}
            onClick={onNegate}
          >
            Negate
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {ownWarnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {ownWarnings.map((w, i) => (
            <li key={`${w.path}-${i}`} className="flex items-start gap-1.5 text-xs text-foreground">
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span>{w.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
