import { COMPARISON_OPERATORS, CONTEXT_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator, Context, ContextField } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

/**
 * The `context` leaf form. `field` is a CLOSED select built from
 * `CONTEXT_FIELDS`, imported from core rather than repeated here -- that
 * list is an injection boundary in the compiler (ast.ts's own doc comment:
 * every entry becomes a real SQL column name, and the allowlist is the
 * only thing between request data and a bare identifier). A free-typed
 * field, or a hand-copied list that could drift from the one the compiler
 * actually checks against, would both reopen exactly what the allowlist
 * exists to close. The `<option>` list below is EXACTLY `CONTEXT_FIELDS`,
 * in the same order, nothing added -- no placeholder option, no
 * capitalisation -- so a test reading the rendered options back can compare
 * them to the import directly.
 */
export function ContextForm(props: {
  id: string
  node: Context
  onChange: (next: Context) => void
}) {
  const { id, node, onChange } = props
  const fieldId = `${id}-field`
  const scopeId = `${id}-scope`
  const operatorId = `${id}-operator`

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={fieldId}>Field</Label>
        <select
          id={fieldId}
          aria-label="Field"
          value={node.field}
          onChange={(e) => onChange({ ...node, field: e.target.value as ContextField })}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          {CONTEXT_FIELDS.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={scopeId}>Scope</Label>
        <select
          id={scopeId}
          aria-label="Scope"
          value={node.scope}
          onChange={(e) => onChange({ ...node, scope: e.target.value as Context['scope'] })}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          <option value="latest">latest</option>
          <option value="first_touch">first touch</option>
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
        onChange={(value) => onChange({ ...node, value } as Context)}
      />
    </div>
  )
}
