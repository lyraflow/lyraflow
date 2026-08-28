import { CONTEXT_FIELDS, OPERATOR_FAMILY } from '@lyraflow/core/segments/ast.js'
import type { Context, ContextField } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import { ClauseValueField } from './ClauseValueField.js'
import { OperatorSelect } from './OperatorSelect.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'
import { clauseValueOf, withOperator } from './clause.js'

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
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="flex min-w-0 flex-col gap-1">
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
      <div className="flex min-w-0 flex-col gap-1">
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
      <OperatorSelect
        id={operatorId}
        value={node.operator}
        // No boolean and no relative-date family, matching `columnClause` in
        // the AST: every context field is a country, a device, a referrer or
        // a campaign. `is true` on one would match nothing and say nothing
        // about why.
        families={['comparison', 'text', 'set']}
        onChange={(operator) => onChange(withOperator(node, operator))}
      />
      {OPERATOR_FAMILY[node.operator] === 'comparison' ? (
        <ValueInput
          operator={node.operator}
          value={clauseValueOf(node) as ConditionValue}
          onChange={(value) => onChange({ ...node, value } as Context)}
        />
      ) : (
        <ClauseValueField
          id={`${id}-value`}
          operator={node.operator}
          value={clauseValueOf(node)}
          onChange={(value) => onChange({ ...node, value } as Context)}
        />
      )}
    </div>
  )
}
