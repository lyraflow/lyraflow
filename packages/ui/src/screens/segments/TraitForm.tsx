import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator, Trait } from '@lyraflow/core/segments/ast.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

/**
 * The `trait` leaf form: a free-typed key (a person property name, not a
 * SQL identifier -- unlike `ContextForm`'s field, this is never compiled
 * into a column name, so a closed list would only get in the way of a
 * property the operator hasn't typed here before), an operator, and a
 * value through the shared `ValueInput`.
 *
 * `id` scopes every control's DOM id to this row's own path -- `ConditionRow`
 * renders one of these per leaf, and an unscoped id (`"trait-key"` on every
 * row) would make every row's `<Label htmlFor>` resolve to whichever row's
 * input happened to render last.
 */
export function TraitForm(props: { id: string; node: Trait; onChange: (next: Trait) => void }) {
  const { id, node, onChange } = props
  const keyId = `${id}-key`
  const operatorId = `${id}-operator`

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={keyId}>Key</Label>
        <Input
          id={keyId}
          aria-label="Key"
          value={node.key}
          onChange={(e) => onChange({ ...node, key: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={operatorId}>Operator</Label>
        <select
          id={operatorId}
          aria-label="Operator"
          value={node.operator}
          onChange={(e) => onChange({ ...node, operator: e.target.value as ComparisonOperator })}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          {COMPARISON_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </div>
      <ValueInput
        operator={node.operator}
        value={node.value as ConditionValue}
        onChange={(value) => onChange({ ...node, value } as Trait)}
      />
    </div>
  )
}
