import { AGGREGATES, COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { Aggregate, Behavior, ComparisonOperator } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Label } from '../../components/ui/label.js'
import { EventCombobox } from '../funnels/EventCombobox.js'
import { PropertyCombobox } from './PropertyCombobox.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'
import { WherePredicates } from './WherePredicates.js'
import { WindowPicker } from './WindowPicker.js'

/**
 * The `behavior` leaf form -- the largest of the four, because a behaviour
 * is five things at once: an event, an aggregate over it, the aggregate's
 * own property (when it needs one), a comparison against the aggregate's
 * result, a time window, and optional `where` predicates narrowing which of
 * the event's occurrences count at all.
 *
 * Two AST rules this form exists to encode rather than merely react to
 * (`ast.ts`'s own `Behavior` refine):
 *
 * - **`count` takes no property; `sum`/`min`/`max`/`distinct` require one.**
 *   `setAggregate` below DROPS `property` from the node outright when
 *   switching to `count` -- not merely hides the field, which would leave a
 *   stale `property` sitting on a node the AST refuses the instant it is
 *   sent. Switching AWAY from `count` seeds an empty string rather than
 *   leaving `property` `undefined`, so the field renders as "not filled in
 *   yet" (matching every other free-typed field in this builder) rather
 *   than reappearing pre-filled with a value the operator never chose.
 * - **`between` takes exactly two values, every other operator exactly
 *   one.** Delegated to `ValueInput` entirely, the same as every other
 *   condition form -- not reimplemented here.
 *
 * Property and predicate suggestions are scoped to the CHOSEN event:
 * `scopeEvent` is `undefined` when
 * `node.event` is `'*'` or unset, which is the honest "suggest across every
 * event" answer for a condition that does not name one -- never the literal
 * string forwarded to the schema endpoint.
 */
export function BehaviourForm(props: {
  id: string
  node: Behavior
  client: ApiClient
  projectId: number
  onChange: (next: Behavior) => void
  onUnauthorized?: () => void
}) {
  const { id, node, client, projectId, onChange, onUnauthorized } = props
  const aggregateId = `${id}-aggregate`
  const operatorId = `${id}-operator`

  const scopeEvent = node.event === '*' || node.event === '' ? undefined : node.event

  function setAggregate(next: Aggregate) {
    if (next === 'count') {
      const { property: _property, ...rest } = node
      onChange({ ...rest, aggregate: next } as Behavior)
    } else {
      onChange({ ...node, aggregate: next, property: node.property ?? '' })
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <EventCombobox
          client={client}
          projectId={projectId}
          value={node.event}
          onChange={(event) => onChange({ ...node, event })}
          label="Event"
          onUnauthorized={onUnauthorized}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={aggregateId}>Aggregate</Label>
          <select
            id={aggregateId}
            aria-label="Aggregate"
            value={node.aggregate}
            onChange={(e) => setAggregate(e.target.value as Aggregate)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
          >
            {AGGREGATES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {node.aggregate !== 'count' && (
          <PropertyCombobox
            client={client}
            projectId={projectId}
            event={scopeEvent}
            value={node.property ?? ''}
            onChange={(property) => onChange({ ...node, property })}
            label="Property"
            onUnauthorized={onUnauthorized}
          />
        )}
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
          onChange={(value) => onChange({ ...node, value } as Behavior)}
        />
      </div>

      <WindowPicker
        id={id}
        value={node.window}
        onChange={(window) => onChange({ ...node, window })}
      />

      <WherePredicates
        id={id}
        event={scopeEvent}
        client={client}
        projectId={projectId}
        value={node.where}
        onChange={(where) => onChange({ ...node, where } as Behavior)}
        onUnauthorized={onUnauthorized}
      />
    </div>
  )
}
