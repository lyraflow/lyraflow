import {
  MAX_WHERE_PREDICATES,
  OPERATOR_FAMILY,
  wherePredicateField,
} from '@lyraflow/core/segments/ast.js'
import type { EventColumnField, WherePredicate } from '@lyraflow/core/segments/ast.js'
import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import type { PropertyKind, SchemaProperty } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { ClauseValueField } from './ClauseValueField.js'
import type { FieldChoice } from './FieldCombobox.js'
import { FieldCombobox } from './FieldCombobox.js'
import { OperatorSelect } from './OperatorSelect.js'
import type { ConditionValue, Scalar } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'
import { clauseValueOf, withOperator } from './clause.js'
import { columnFieldNote } from './columnFields.js'
import { coerceForKind, kindNote, learnKinds } from './propertyKinds.js'

/** A freshly added predicate -- an empty property, `=`, and an empty value,
 * the same starting shape `GroupCard.newCondition` gives a fresh trait leaf.
 * Invalid by the AST's own `property.min(1)` until the operator fills it
 * in, same as every other "just added" leaf in this builder. */
function newPredicate(): WherePredicate {
  return { property: '', operator: '=', value: '' }
}

/**
 * An attribute predicate's value is a string in the AST, because every
 * column one can name is `String` in ClickHouse. Everything this editor
 * produces is already text, but a tree written through the API can carry a
 * number -- and switching such a predicate from a property to an attribute
 * would otherwise build a tree the server then refuses, with the operator
 * looking at a form that seems complete.
 */
function asText(value: ConditionValue): string | [string, string] {
  const one = (v: Scalar): string => (v == null ? '' : String(v))
  return Array.isArray(value) ? [one(value[0]), one(value[1])] : one(value)
}

/**
 * The same predicate, now naming `choice`. Operator and value are carried
 * across deliberately: an operator who picked the wrong half of the picker
 * is correcting the FIELD, and making them retype `august-digest` because
 * of it would be the form punishing them for its own ambiguity.
 */
function withField(p: WherePredicate, choice: FieldChoice): WherePredicate {
  const carried = clauseValueOf(p)

  if (choice.source !== 'attribute') {
    // No `source` written for a property predicate: absent is what every tree
    // saved before attribute predicates existed carries, and writing
    // `source: 'property'` on every save would make an untouched segment
    // serialise differently from the one on disk -- which the funnel store's
    // own equality check reads as a change.
    //
    // The value key is omitted rather than set to `undefined` when the
    // operator carries none, for the reason `withOperator` gives.
    return {
      property: choice.name,
      operator: p.operator,
      ...(carried === undefined ? {} : { value: carried }),
    } as WherePredicate
  }

  const attribute = choice.name as EventColumnField
  const family = OPERATOR_FAMILY[p.operator]

  // A column is never a flag and never a date -- `columnClause` in the AST
  // admits neither family on an attribute -- so those two operators cannot
  // travel with the field. Reset to `is` with an empty value rather than
  // carry one the server would refuse: the row then reads as unfinished,
  // which it now is, instead of looking complete and failing on save.
  if (family === 'boolean' || family === 'relative') {
    return { source: 'attribute', attribute, operator: '=', value: '' }
  }
  if (family === 'set')
    return { source: 'attribute', attribute, operator: p.operator } as WherePredicate
  // Text values are already strings; a comparison value may be a number a
  // tree written through the API carried, so it goes through `asText`.
  return {
    source: 'attribute',
    attribute,
    operator: p.operator,
    value: family === 'text' ? String(carried ?? '') : asText(carried as ConditionValue),
  } as WherePredicate
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

  // What the schema has said about each property NAME, accumulated across
  // every row's own lookup. See `learnKinds` for why it accumulates and why
  // it is keyed by name rather than by row.
  const [kinds, setKinds] = useState<Record<string, PropertyKind>>({})
  const learn = useCallback((reported: SchemaProperty[]) => {
    setKinds((known) => learnKinds(known, reported))
  }, [])

  /**
   * Retypes any value whose property's kind is known and disagrees with it.
   *
   * An effect, not a step inside the change handlers, because the two facts
   * arrive in either order: an operator may choose the property and then type
   * the value, or type the value into a row they are correcting and choose
   * the property after. Only one of those orders can be handled at the
   * keystroke; the other needs the tree revisited once the kind lands.
   *
   * This is the same self-healing shape `ValueInput` already uses to keep
   * `between` and its value in agreement, for the same reason: the form's own
   * state is the thing being repaired, and repairing it where it is noticed
   * beats making every handler remember.
   *
   * Converges because `coerceForKind` returns its argument by identity when
   * there is nothing to do, so the write-back happens once per genuine
   * change and the next run finds nothing.
   */
  useEffect(() => {
    if (value === undefined) return
    let changed = false
    const healed = value.map((p) => {
      if (p.source === 'attribute') return p
      // Comparison operators only, for the reason `TraitForm`'s copy of this
      // guard gives: coercion exists to route a numeric property to
      // `properties_num`, and that routing happens in `wherePredicate`'s
      // comparison branch alone. Left ungated it rewrites a substring to a
      // number and a relative window to a string, every render.
      if (OPERATOR_FAMILY[p.operator] !== 'comparison') return p
      const current = clauseValueOf(p) as ConditionValue
      const next = coerceForKind(current, kinds[p.property])
      if (next === current) return p
      changed = true
      return { ...p, value: next } as WherePredicate
    })
    if (changed) onChange(healed)
  }, [kinds, value, onChange])
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
        const field = wherePredicateField(p)
        // Only ever about a PROPERTY predicate: an attribute predicate has
        // already reached the column, so the note would be describing a
        // problem the row does not have. Said HERE, while the name is being
        // typed, rather than at save time -- the predicate is not invalid,
        // it simply reads a map this name is not in. See `columnFields.ts`.
        // Two notes, one slot, and they cannot both apply: `columnFieldNote`
        // fires when a property row names an ATTRIBUTE, `kindNote` when it
        // names a property whose kind nothing has established. The first is
        // checked first because a name that is an attribute is the more
        // specific thing to say about it.
        const note =
          field.source === 'property'
            ? (columnFieldNote(field.name) ??
              kindNote(field.name, kinds[field.name], clauseValueOf(p) as ConditionValue))
            : null
        return (
          <div key={rowId} data-testid={rowId} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <FieldCombobox
                client={client}
                projectId={projectId}
                event={event}
                value={field}
                onChange={(choice) => updateAt(i, withField(p, choice))}
                onProperties={learn}
                onUnauthorized={onUnauthorized}
              />
              <OperatorSelect
                id={operatorId}
                value={p.operator}
                // Per ROW, not per screen: a predicate on a property may be a
                // flag or a date, while one on an event COLUMN is neither --
                // the same split `PropertyPredicate` and `AttributePredicate`
                // make in the AST. A single list here would offer `is true`
                // on `utm_campaign`.
                families={
                  p.source === 'attribute'
                    ? ['comparison', 'text', 'set']
                    : ['comparison', 'text', 'set', 'boolean', 'relative']
                }
                onChange={(operator) => updateAt(i, withOperator(p, operator))}
              />
              {OPERATOR_FAMILY[p.operator] === 'comparison' ? (
                <ValueInput
                  operator={p.operator}
                  value={clauseValueOf(p) as ConditionValue}
                  onChange={(val) => updateAt(i, { ...p, value: val } as WherePredicate)}
                />
              ) : (
                <ClauseValueField
                  id={rowId}
                  operator={p.operator}
                  value={clauseValueOf(p)}
                  onChange={(val) => updateAt(i, { ...p, value: val } as WherePredicate)}
                />
              )}
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
          {`Adding here would bring this event to ${MAX_WHERE_PREDICATES + 1} conditions; the maximum is ${MAX_WHERE_PREDICATES}.`}
        </p>
      )}
    </div>
  )
}
