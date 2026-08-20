import type { Trait } from '@lyraflow/core/segments/ast.js'
import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import type { PropertyKind, SchemaProperty } from '../../api/types.js'
import { OperatorSelect } from './OperatorSelect.js'
import { PropertyCombobox } from './PropertyCombobox.js'
import { TraitValueField } from './TraitValueField.js'
import type { ConditionValue } from './ValueInput.js'
import { coerceForKind, kindNote, learnKinds } from './propertyKinds.js'

/** The event name the ingest path assigns to an identify payload, whose
 * property bag IS the traits bag (`eventName`/`toEventRow`,
 * `packages/server/src/ingest/row.ts`). `event_schema`'s materialised views
 * catalogue every event's property keys with no event filter, so scoping a
 * property lookup to this name returns exactly the trait keys this project
 * has recorded -- which is why suggesting traits needs no endpoint of its
 * own. Kept as a named constant because the leading `$` makes it look like
 * a placeholder to anyone reading the call site. */
const IDENTIFY_EVENT = '$identify'

/**
 * The `trait` leaf form: a trait name, an operator, and a value through the
 * shared `ValueInput`.
 *
 * The name stays free-typed. Unlike `ContextForm`'s field it is never
 * compiled into a column name, so a closed list would only block a trait the
 * project has not sent yet -- legitimate, since a segment may be written
 * ahead of the instrumentation that fills it. But free-typed was being
 * shipped as a bare text box labelled "Key", which asks the operator to
 * guess both what the field means and what the project actually records.
 * Suggestions come from the schema; the field still accepts anything.
 *
 * The VALUE is suggested too, through `TraitValueField`, and on deliberately
 * different terms: knowing that a project records `plan` is useless if the
 * operator then has to guess between `pro`, `Pro` and `tier_2`, and a wrong
 * guess produces a segment that is silently empty rather than an error. But
 * those suggestions come from a scan of the trait table rather than a
 * catalogue, so they are fetched only when the operator focuses the value
 * box -- never on render, unlike the name field directly above it. Both
 * fields open their list on focus; only the moment of the REQUEST differs,
 * and that asymmetry is the cost of the two reads, not an inconsistency.
 *
 * `id` scopes every control's DOM id to this row's own path -- `ConditionRow`
 * renders one of these per leaf, and an unscoped id (`"trait-key"` on every
 * row) would make every row's `<Label htmlFor>` resolve to whichever row's
 * input happened to render last. `PropertyCombobox` generates its own id via
 * `useId`, so the key field no longer needs one from here.
 */
export function TraitForm(props: {
  id: string
  node: Trait
  onChange: (next: Trait) => void
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
}) {
  const { id, node, onChange, client, projectId, onUnauthorized } = props
  const operatorId = `${id}-operator`

  // A trait predicate reads `t_str` or `t_num`, and `traitExpr` chooses from
  // the JavaScript type of the value exactly as `wherePredicate` does -- so a
  // numeric trait typed into this form read the string map and matched
  // nobody. Verified live at the time of the fix: `seats = "12"` found 0
  // people where `seats = 12` found 20. Same defect, same repair; see
  // `propertyKinds.ts`, and `WherePredicates` for why this heals from an
  // effect rather than inside the change handlers.
  const [kinds, setKinds] = useState<Record<string, PropertyKind>>({})
  const learn = useCallback((reported: SchemaProperty[]) => {
    setKinds((known) => learnKinds(known, reported))
  }, [])

  useEffect(() => {
    const next = coerceForKind(node.value as ConditionValue, kinds[node.key])
    if (next !== node.value) onChange({ ...node, value: next } as Trait)
  }, [kinds, node, onChange])

  const note = kindNote(node.key, kinds[node.key], node.value as ConditionValue)

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <PropertyCombobox
          client={client}
          projectId={projectId}
          event={IDENTIFY_EVENT}
          value={node.key}
          onChange={(key) => onChange({ ...node, key })}
          label="Trait"
          placeholder="e.g. plan"
          hint="Set on a person by identify(). Start typing to search."
          emptyMessage="No traits recorded yet -- they appear here once your app calls identify()."
          onProperties={learn}
          onUnauthorized={onUnauthorized}
        />
        <OperatorSelect
          id={operatorId}
          value={node.operator}
          onChange={(operator) => onChange({ ...node, operator })}
        />
        <TraitValueField
          client={client}
          projectId={projectId}
          trait={node.key}
          operator={node.operator}
          value={node.value as ConditionValue}
          onChange={(value) => onChange({ ...node, value } as Trait)}
          onUnauthorized={onUnauthorized}
        />
      </div>
      {/* Muted, not `destructive`: nothing here is refused and the operator
       * did nothing wrong -- the kind of this trait simply is not established,
       * so the condition reads it as text. */}
      {note != null && (
        <p data-testid={`${id}-kind-note`} className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}
