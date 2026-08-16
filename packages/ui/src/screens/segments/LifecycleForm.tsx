import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator, Lifecycle } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

/**
 * `ast.ts` inlines this as `z.enum(['first_seen', 'last_seen'])` rather
 * than exporting a named constant the way `CONTEXT_FIELDS` is exported --
 * there is no compiled-SQL injection boundary here (`field` picks between
 * two fixed timestamp columns the compiler already knows about, it is
 * never interpolated from this value), so this list is an ordinary UI
 * concern, not a security one. Still worth keeping in one place: if
 * ast.ts's enum ever grows a third lifecycle field, this needs the same
 * edit.
 */
const LIFECYCLE_FIELDS = ['first_seen', 'last_seen'] as const

/**
 * The `lifecycle` leaf form. Its value is always an instant (`ast.ts`'s
 * own doc comment on `Lifecycle`: "Lifecycle bounds are instants, so every
 * value must be a parseable datetime"), enforced there by a refine that
 * rejects anything `new Date()` can't parse -- a free text box would let
 * an operator type something that refine already knows to reject. Passing
 * `type="datetime-local"` through to `ValueInput` gets a native date/time
 * picker instead, so what this control can produce is a subset of what
 * the schema accepts, not merely values the schema also happens to check.
 */
export function LifecycleForm(props: {
  id: string
  node: Lifecycle
  onChange: (next: Lifecycle) => void
}) {
  const { id, node, onChange } = props
  const fieldId = `${id}-field`
  const operatorId = `${id}-operator`

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={fieldId}>Field</Label>
        <select
          id={fieldId}
          aria-label="Field"
          value={node.field}
          onChange={(e) => onChange({ ...node, field: e.target.value as Lifecycle['field'] })}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          {LIFECYCLE_FIELDS.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
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
        onChange={(value) => onChange({ ...node, value } as Lifecycle)}
        type="datetime-local"
      />
    </div>
  )
}
