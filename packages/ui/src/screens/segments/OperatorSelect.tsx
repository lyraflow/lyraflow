import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator } from '@lyraflow/core/segments/ast.js'
import { Label } from '../../components/ui/label.js'

/**
 * The word an operator reads as in the UI. PRESENTATION ONLY -- the stored
 * AST is unchanged, and the CLI keeps the symbols, which are the right
 * register there.
 *
 * A `Record<ComparisonOperator, string>` rather than a lookup with a
 * fallback, deliberately. The fallback spelling (`LABELS[op] ?? op`) is the
 * one that fails silently: an operator added to `COMPARISON_OPERATORS` in
 * core renders as a raw symbol in five selects and nothing anywhere goes red.
 * With an exhaustive record, `tsc` refuses to compile until the new operator
 * has a word -- which is a guard no test can express, so this module's tests
 * pin the observable half instead (every operator in core has a label, and no
 * label is its own symbol).
 */
const LABELS: Record<ComparisonOperator, string> = {
  '=': 'is',
  '!=': 'is not',
  '>': 'more than',
  '>=': 'at least',
  '<': 'less than',
  '<=': 'at most',
  between: 'between',
}

/**
 * Every operator the AST accepts, in the order core declares them, each with
 * the word it reads as. Driven off `COMPARISON_OPERATORS` rather than off the
 * record's own keys, so the ORDER is core's and the list can never be a
 * subset of it.
 *
 * `value` is the operator exactly as the AST stores it -- never relabelled,
 * never re-ordered -- which is what lets every existing test that selects an
 * option by its value keep working unchanged.
 */
export const OPERATOR_OPTIONS: { value: ComparisonOperator; label: string }[] =
  COMPARISON_OPERATORS.map((value) => ({ value, label: LABELS[value] }))

/**
 * The operator control, in one place instead of five.
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
