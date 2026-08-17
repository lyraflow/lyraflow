import { AGGREGATES } from '@lyraflow/core/segments/ast.js'
import type { Aggregate, Behavior } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Label } from '../../components/ui/label.js'
import { EventCombobox } from '../funnels/EventCombobox.js'
import { OperatorSelect } from './OperatorSelect.js'
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
        <OperatorSelect
          id={operatorId}
          value={node.operator}
          onChange={(operator) => onChange({ ...node, operator })}
        />
        <ValueInput
          operator={node.operator}
          value={node.value as ConditionValue}
          onChange={(value) => onChange({ ...node, value } as Behavior)}
        />
        {/* The word that finishes the sentence for the one aggregate whose
         * comparison is against a NUMBER OF OCCURRENCES. "purchase count at
         * least 3 times in the last 10 days" reads; "sum of amount at least 3
         * times" does not, so this appears only for `count`. */}
        {node.aggregate === 'count' && (
          <span className="pb-2 text-sm text-muted-foreground">times</span>
        )}
      </div>

      {/* Kept on its own line rather than folded into the wrapping row above,
       * and that is a measured choice, not an oversight. The `last` variant is
       * three rows tall (label, select, then amount+unit) against two for
       * every other control, so under the row's `items-end` it would
       * bottom-align and hang its own select a full row ABOVE its
       * neighbours -- the same class of accident `ConditionRow`'s own layout
       * comment records, where width after layout did not predict the break.
       * The sentence still reads across the wrap: "purchase count at least 3
       * times" / "in the last 10 days". */}
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
