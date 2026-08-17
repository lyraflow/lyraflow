import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { OperatorSelect } from './OperatorSelect.js'
import { PropertyCombobox } from './PropertyCombobox.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

/** A freshly added predicate -- an empty property, `=`, and an empty value,
 * the same starting shape `GroupCard.newCondition` gives a fresh trait leaf.
 * Invalid by the AST's own `property.min(1)` until the operator fills it
 * in, same as every other "just added" leaf in this builder. */
function newPredicate(): WherePredicate {
  return { property: '', operator: '=', value: '' }
}

/**
 * Editor for a `WherePredicate[]` -- the property constraints on ONE event,
 * scoped by `event` (`undefined` for "no scoping",
 * never the literal `'*'` or `''`; the caller decides that, this component
 * only forwards it).
 *
 * Deliberately generic over what OWNS the array: nothing here imports
 * `Behavior` or any other segment-tree type, only `WherePredicate` itself --
 * the type `packages/core/src/funnels/ast.ts` already reuses VERBATIM for a
 * funnel step's own `where` ("A caller writes the same predicate in a
 * segment and in a funnel step... a second spelling would be two grammars
 * for one idea", that file's own doc comment). A future funnel-step
 * predicate editor can render this exact component against `step.where` and
 * `step.event` -- there is no segment-specific assumption baked in here to
 * unpick first.
 *
 * `value` is `undefined` for "no predicates yet" -- `Behavior.where` is
 * `.optional()`, not a default `[]`, and this preserves that distinction on
 * the way out: removing the last predicate reports `undefined`, never an
 * empty array, so a round-trip through this component cannot turn an
 * "unset" behaviour into one carrying `where: []`.
 */
export function WherePredicates(props: {
  id: string
  event: string | undefined
  client: ApiClient
  projectId: number
  value: WherePredicate[] | undefined
  onChange: (next: WherePredicate[] | undefined) => void
  onUnauthorized?: () => void
}) {
  const { id, event, client, projectId, value, onChange, onUnauthorized } = props
  const predicates = value ?? []

  function updateAt(i: number, next: WherePredicate) {
    onChange(predicates.map((p, idx) => (idx === i ? next : p)))
  }
  function removeAt(i: number) {
    const next = predicates.filter((_, idx) => idx !== i)
    onChange(next.length === 0 ? undefined : next)
  }
  function add() {
    onChange([...predicates, newPredicate()])
  }

  return (
    <div className="flex flex-col gap-2 border-l border-border pl-3">
      <span className="text-sm font-medium text-foreground">Where</span>
      {predicates.map((p, i) => {
        const rowId = `${id}-where-${i}`
        const operatorId = `${rowId}-operator`
        return (
          <div key={rowId} data-testid={rowId} className="flex min-w-0 flex-wrap items-end gap-2">
            <PropertyCombobox
              client={client}
              projectId={projectId}
              event={event}
              value={p.property}
              onChange={(property) => updateAt(i, { ...p, property })}
              label="Property"
              onUnauthorized={onUnauthorized}
            />
            <OperatorSelect
              id={operatorId}
              value={p.operator}
              onChange={(operator) => updateAt(i, { ...p, operator })}
            />
            <ValueInput
              operator={p.operator}
              value={p.value as ConditionValue}
              onChange={(val) => updateAt(i, { ...p, value: val } as WherePredicate)}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => removeAt(i)}>
              Remove
            </Button>
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={add}>
        Add predicate
      </Button>
    </div>
  )
}
