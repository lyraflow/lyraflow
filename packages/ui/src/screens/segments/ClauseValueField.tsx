import { OPERATOR_FAMILY } from '@lyraflow/core/segments/ast.js'
import type { Operator, RelativeWindow } from '@lyraflow/core/segments/ast.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

/** The same ceiling `Window`'s `last` variant uses, and for the same reason. */
const MAX_RELATIVE_N = 3650

/**
 * The value control for the operator families that are NOT comparisons.
 *
 * Each condition form keeps its own comparison control -- a trait's suggests
 * recorded values, a lifecycle bound is a `datetime-local`, a behaviour's is
 * a number -- because what a value means differs per target. What does NOT
 * differ per target is the other three families: a substring is a substring
 * on a trait and on a URL alike, `is set` takes nothing anywhere, and a
 * relative window is `{n, unit}` everywhere. Four copies of that would be
 * four chances for three of them to be updated.
 *
 * The presence and boolean families render NO input and say so. An empty gap
 * where a value box was is a row that looks unfinished; the sentence is what
 * tells the operator the condition is complete.
 */
export function ClauseValueField(props: {
  id: string
  operator: Operator
  value: unknown
  onChange: (value: unknown) => void
}) {
  const { id, operator, value, onChange } = props
  const family = OPERATOR_FAMILY[operator]

  if (family === 'set' || family === 'boolean') {
    return (
      <p data-testid={`${id}-no-value`} className="self-end pb-2 text-xs text-muted-foreground">
        No value needed.
      </p>
    )
  }

  if (family === 'relative') {
    // Defaulted rather than trusted: this renders from a tree that may have
    // been written by the API or the CLI, and a half-built one reaching a
    // controlled `<Input value={undefined}>` would switch it to uncontrolled
    // mid-edit.
    const w = (value ?? { n: 7, unit: 'days' }) as RelativeWindow
    return (
      <div className="flex min-w-0 items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-n`}>Amount</Label>
          <Input
            id={`${id}-n`}
            aria-label="Value amount"
            type="number"
            min={1}
            max={MAX_RELATIVE_N}
            value={w.n}
            onChange={(e) => onChange({ n: Number(e.target.value), unit: w.unit })}
            className="w-24"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-unit`}>Unit</Label>
          <select
            id={`${id}-unit`}
            aria-label="Value unit"
            value={w.unit}
            onChange={(e) => onChange({ n: w.n, unit: e.target.value as RelativeWindow['unit'] })}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </div>
    )
  }

  // Text. Always a plain string, whatever the target's comparison control
  // would have offered: `contains 5` is a substring match against "5", not a
  // numeric one, and a control that coerced it to a number here would compile
  // to a search of the map that does not hold it.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={`${id}-text`}>Value</Label>
      <Input
        id={`${id}-text`}
        aria-label="Value"
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
