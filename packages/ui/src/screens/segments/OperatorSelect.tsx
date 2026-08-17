import type { ComparisonOperator } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import { OPERATOR_OPTIONS } from './vocabulary.js'

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
 */
export function OperatorSelect(props: {
  id: string
  value: ComparisonOperator
  onChange: (next: ComparisonOperator) => void
}) {
  const { id, value, onChange } = props
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>Operator</Label>
      <select
        id={id}
        aria-label="Operator"
        value={value}
        onChange={(e) => onChange(e.target.value as ComparisonOperator)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        {OPERATOR_OPTIONS.map(({ value: op, label }) => (
          <option key={op} value={op}>
            {label}
          </option>
        ))}
      </select>
    </div>
  )
}
