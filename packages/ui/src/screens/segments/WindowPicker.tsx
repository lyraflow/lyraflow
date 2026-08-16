import type { Window } from '@lyraflow/core/segments/ast.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

const WINDOW_KINDS = ['last', 'absolute', 'ever'] as const

/** Only the `last` variant has a `unit` -- `Window['unit']` does not
 * typecheck across the whole union, so this is pulled out via `Extract`
 * rather than widened to `string` and cast blindly. */
type LastUnit = Extract<Window, { kind: 'last' }>['unit']

/**
 * `Number.isSafeInteger`, not `Number.isInteger` -- the latter is true for
 * 1e20, which reaches the database as a bigint bind and returns a 503, an
 * input error wearing an outage's clothes. This is (at least) the sixth
 * home of that check in this repository.
 */
function isValidN(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0
}

/**
 * `Window` is a three-variant discriminated union (`ast.ts`): `last` takes a
 * positive safe integer and a unit, `absolute` takes two datetimes, `ever`
 * takes nothing. This control switches between them with a single select,
 * and every switch REPLACES `value` wholesale with a fresh literal for the
 * new variant -- never spreads the old one -- which is what keeps a
 * variant's own fields from surviving a switch away from it. Spreading
 * `{...value, kind: next}` would leave `n`/`unit` on an `absolute` node, or
 * `from`/`to` on a `last` one: fields the AST's own discriminated union
 * would refuse to parse back, produced by this UI rather than a hand-built
 * request.
 *
 * `id` scopes every control's DOM id to the caller's own row, the same
 * convention `TraitForm`/`ContextForm`/`LifecycleForm` use -- `BehaviourForm`
 * renders one of these per behaviour condition.
 */
export function WindowPicker(props: {
  id: string
  value: Window
  onChange: (next: Window) => void
}) {
  const { id, value, onChange } = props
  const kindId = `${id}-window-kind`
  const amountId = `${id}-window-amount`

  function setKind(kind: Window['kind']) {
    if (kind === value.kind) return
    if (kind === 'last') onChange({ kind: 'last', n: 1, unit: 'days' })
    else if (kind === 'absolute') onChange({ kind: 'absolute', from: '', to: '' })
    else onChange({ kind: 'ever' })
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={kindId}>Window</Label>
      <select
        id={kindId}
        aria-label="Window"
        value={value.kind}
        onChange={(e) => setKind(e.target.value as Window['kind'])}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        {WINDOW_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind === 'last' ? 'in the last' : kind === 'absolute' ? 'between' : 'ever'}
          </option>
        ))}
      </select>

      {value.kind === 'last' && (
        <div className="flex items-center gap-2">
          <Input
            id={amountId}
            type="number"
            min={1}
            step={1}
            aria-label="Window amount"
            aria-invalid={!isValidN(value.n)}
            value={value.n}
            onChange={(e) =>
              onChange({ kind: 'last', n: Number(e.target.value), unit: value.unit })
            }
            className="w-24"
          />
          <select
            aria-label="Window unit"
            value={value.unit}
            onChange={(e) =>
              onChange({ kind: 'last', n: value.n, unit: e.target.value as LastUnit })
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      )}
      {value.kind === 'last' && !isValidN(value.n) && (
        <p className="text-xs text-destructive">
          Enter a whole number of {value.unit} greater than zero.
        </p>
      )}

      {value.kind === 'absolute' && (
        <div className="flex items-center gap-2">
          <Input
            type="datetime-local"
            aria-label="From"
            value={value.from}
            onChange={(e) => onChange({ kind: 'absolute', from: e.target.value, to: value.to })}
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            type="datetime-local"
            aria-label="To"
            value={value.to}
            onChange={(e) => onChange({ kind: 'absolute', from: value.from, to: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}
