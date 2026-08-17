import { MAX_WHERE_PREDICATES } from '@lyraflow/core/segments/ast.js'
import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { OperatorSelect } from './OperatorSelect.js'
import { PropertyCombobox } from './PropertyCombobox.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'
import { columnFieldNote } from './columnFields.js'

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
 * for one idea", that file's own doc comment). `StepRows` renders this exact
 * component against `step.where` and `step.event`; it needed no fork, and
 * the only change either caller asked for was the shared cap below.
 *
 * It therefore has TWO callers now, and a change made for one is a change
 * to the other: keep every prop about "an event and its predicates", never
 * about a behaviour node or a funnel step.
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
  // The AST caps a `where` array at `MAX_WHERE_PREDICATES` for a behaviour
  // and for a funnel step alike, and the constant comes from the schema
  // that rejects it rather than being retyped here -- a form that lets an
  // operator build an eleventh predicate has only moved the refusal to
  // after they finished writing it.
  const atCap = predicates.length >= MAX_WHERE_PREDICATES

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
    // The whole list is addressable, not just its rows: with more than one
    // of these on a screen (a funnel's steps each have their own), "Add
    // predicate" is otherwise ambiguous between them -- to a test, and to
    // anything else addressing controls by name.
    <div data-testid={`${id}-where`} className="flex flex-col gap-2 border-l border-border pl-3">
      <span className="text-sm font-medium text-foreground">Where</span>
      {predicates.map((p, i) => {
        const rowId = `${id}-where-${i}`
        const operatorId = `${rowId}-operator`
        // Said HERE, while the name is being typed, rather than at save
        // time: the predicate is not invalid, it simply reads a map this
        // name is not in, and a rejection on save would refuse a field this
        // builder deliberately leaves free-typed. See `columnFields.ts`.
        const note = columnFieldNote(p.property)
        return (
          <div key={rowId} data-testid={rowId} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
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
            {/* Muted, not `destructive` and not `role="alert"`: this is a
             * limit of where the value lives, not an error the operator
             * caused, and nothing here refuses the input. */}
            {note != null && (
              <p data-testid={`${rowId}-note`} className="text-xs text-muted-foreground">
                {note}
              </p>
            )}
          </div>
        )
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={atCap}
        onClick={add}
      >
        Add predicate
      </Button>
      {/* Said, not merely enforced -- the same shape `GroupCard` uses for
       * the three tree caps: a control that stops working without saying
       * which limit it hit reads as a broken button. */}
      {atCap && (
        <p className="text-xs text-muted-foreground">
          {`Adding here would bring this event to ${MAX_WHERE_PREDICATES + 1} property conditions; the maximum is ${MAX_WHERE_PREDICATES}.`}
        </p>
      )}
    </div>
  )
}
