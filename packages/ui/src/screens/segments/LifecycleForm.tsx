import { LIFECYCLE_FIELDS, type Lifecycle } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'
import { OperatorSelect } from './OperatorSelect.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'
import { valueToPicker, valueToStored } from './datetime.js'

/**
 * The `lifecycle` leaf form. Its value is always an instant (`ast.ts`'s
 * own doc comment on `Lifecycle`: "Lifecycle bounds are instants, so every
 * value must be a parseable datetime"), enforced there by a refine that
 * rejects anything `new Date()` can't parse -- a free text box would let
 * an operator type something that refine already knows to reject. Passing
 * `type="datetime-local"` through to `ValueInput` gets a native date/time
 * picker instead, so what this control can produce is a subset of what
 * the schema accepts, not merely values the schema also happens to check.
 *
 * **The value is CONVERTED in both directions** (`valueToPicker` /
 * `valueToStored`, `datetime.ts`, which owns the rule and states it in full).
 * This form used to hand `node.value` straight to the input and write the
 * input's own text straight back, which is the same defect `WindowPicker`
 * records as fixed for the `absolute` window -- and it was worse here,
 * because it was SILENT: a `datetime-local` input renders nothing at all for
 * a `Z`-suffixed instant, so a saved bound written by the API, the CLI, or
 * this screen's own kind switcher opened as an EMPTY control, with no "this
 * condition is not finished" message either, since the node it was rendering
 * is perfectly valid. An operator saw a lifecycle condition with no date and
 * nothing to explain it.
 *
 * The blind spot that carried it is worth naming, because it is the same one
 * `WindowPicker`'s comment names: every test in this file built a `Lifecycle`
 * node directly, and every one of those fixtures happened to hold a zone-less
 * reading -- the one shape an unconverted read renders correctly. The tests
 * that pin this now drive a `Z`-suffixed value INTO the control and read the
 * input back.
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
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="flex min-w-0 flex-col gap-1">
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
      <OperatorSelect
        id={operatorId}
        value={node.operator}
        onChange={(operator) => onChange({ ...node, operator })}
      />
      <ValueInput
        operator={node.operator}
        value={valueToPicker(node.value as ConditionValue)}
        onChange={(value) => onChange({ ...node, value: valueToStored(value) } as Lifecycle)}
        type="datetime-local"
      />
    </div>
  )
}
