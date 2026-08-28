import type { Operator } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import { OPERATOR_GROUPS } from './vocabulary.js'

/** Which operator families a control offers. Named so a form's call site
 * reads as the claim it is making about its target. */
export type OperatorFamily = 'comparison' | 'text' | 'set' | 'boolean' | 'relative'

/**
 * The operator control, in one place instead of five.
 *
 * The words themselves live in `vocabulary.ts`, not here, because `summarise`
 * needs the same ones -- see that module's own doc comment for why a
 * vocabulary that lives inside the first component to need it drifts.
 *
 * `TraitForm`, `ContextForm`, `LifecycleForm`, `BehaviourForm` and
 * `WherePredicates` each rendered a byte-identical copy of this select, and
 * five copies of one list is five chances for four of them to be updated. The
 * accessible name stays exactly `Operator` -- several test files address this
 * field by it (`{ name: /operator/i }`) and none of them need changing.
 *
 * **`families` is required, and it mirrors what the AST admits for that
 * target.** The clause union in `ast.ts` gives each target a different set --
 * a column takes no `is true`, a lifecycle bound takes no `contains`, a
 * behavioural count takes only comparisons -- and a select offering an
 * operator the server then refuses is a control that teaches the operator the
 * rule by failing. Passing the set here rather than deriving it keeps the two
 * declarations next to their targets, and `vocabulary.test.ts` pins that
 * every family a form offers is one its node type accepts.
 *
 * Rendered as `<optgroup>`s once there is more than one family: nineteen flat
 * options is a list an operator scrolls rather than reads. One family renders
 * bare, because a single group heading over the whole list names nothing.
 */
export function OperatorSelect(props: {
  id: string
  value: Operator
  families: readonly OperatorFamily[]
  onChange: (next: Operator) => void
}) {
  const { id, value, families, onChange } = props
  const groups = OPERATOR_GROUPS.filter((g) => families.includes(g.family))
  const flat = groups.length === 1

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>Operator</Label>
      <select
        id={id}
        aria-label="Operator"
        value={value}
        onChange={(e) => onChange(e.target.value as Operator)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        {groups.map((group) =>
          flat ? (
            group.options.map(({ value: op, label }) => (
              <option key={op} value={op}>
                {label}
              </option>
            ))
          ) : (
            <optgroup key={group.family} label={group.label}>
              {group.options.map(({ value: op, label }) => (
                <option key={op} value={op}>
                  {label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </div>
  )
}
