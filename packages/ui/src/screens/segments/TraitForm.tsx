import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { ComparisonOperator, Trait } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Label } from '../../components/ui/label.js'
import { PropertyCombobox } from './PropertyCombobox.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

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
 * `suggestOnEmpty` is on here and off for `where` predicates on purpose: a
 * project's trait namespace is small and its operator's problem is not
 * narrowing a list but knowing which traits exist at all, whereas an event's
 * property namespace is large and an unfiltered list is mostly noise.
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

  return (
    <div className="flex flex-wrap items-end gap-2">
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
        suggestOnEmpty
        onUnauthorized={onUnauthorized}
      />
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
        onChange={(value) => onChange({ ...node, value } as Trait)}
      />
    </div>
  )
}
