import { AGGREGATES } from '@lyraflow/core/segments/ast.js'
import type { Aggregate, Behavior } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { EventCombobox } from '../../components/EventCombobox.js'
import { Label } from '../../components/ui/label.js'
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
    /* `min-w-0`, and NOT `flex-1`. The `flex-1` this root used to carry is
     * the direct cause of two shipped layout defects in `ConditionRow` (its
     * own comment has both): a `flex: 1 1 0%` basis of zero means this form
     * can never push a sibling onto its own line, so anything sharing a row
     * with it ended up parked at this form's vertical middle. It shares a row
     * with nothing now, so the property has no work left to do -- and in a
     * COLUMN parent it would be a grow factor on height, which is not
     * something this form should be asking for either.
     *
     * `min-w-0` is the other half, and it is what stops the fields being
     * clipped at 390px: without it every flex item below is floored at its
     * own min-content width, and a native input's min-content does not
     * shrink. Measured, a depth-three behaviour held 553px of content in a
     * 198px box, and the page did not overflow -- the clipping was entirely
     * inside `main`, so nothing on screen signalled that the `Aggregate`,
     * `Property`, second `between` bound and whole `to` bound existed at
     * all. */
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <EventCombobox
          client={client}
          projectId={projectId}
          value={node.event}
          onChange={(event) => onChange({ ...node, event })}
          label="Event"
          onUnauthorized={onUnauthorized}
        />
        <div className="flex min-w-0 flex-col gap-1">
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
        {/* The value and the word that qualifies it are ONE flex item, not two
         * siblings of the wrapping row -- because as two siblings they were
         * measured 66px apart vertically (86px when the window was an
         * absolute range). `ValueInput`'s box is `w-full`, so as a direct
         * child of a wrapping row it claimed a whole flex line, and `times`
         * wrapped onto the line after it and then bottom-aligned under the
         * row's `items-end` to whatever was tallest there. "purchase count at
         * least 3" on one line and "times" alone on the next reads as
         * qualifying the WINDOW below it rather than the number above it.
         *
         * Pairing them here fixes it at the level the relationship actually
         * exists: `times` belongs to the value, so it travels with the value
         * wherever the row breaks. `flex-1` gives the pair a zero basis so it
         * joins the operator's line when there is room, and `min-w-0` lets
         * the box shrink beside the word instead of pushing it away.
         *
         * `between` is the one case that takes a line of its own below `sm`,
         * because it is two boxes and a conjunction rather than one box: sharing
         * a narrow line with the operator select made the pair wrap INSIDE
         * itself, so the page read `100 and` on one line and `between 5000` on
         * the next, with the conjunction stranded above the operator it belongs
         * after. A full basis costs one line and keeps `100 and 5000` together.
         * Every other operator has one box and stays on the operator's line,
         * which is what makes `count at least 3 times` read as a sentence at
         * 390px. */}
        <div
          className={`flex min-w-0 items-end gap-2 ${
            node.operator === 'between' ? 'basis-full sm:flex-1 sm:basis-0' : 'flex-1'
          }`}
        >
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
            <span className="shrink-0 pb-2 text-sm text-muted-foreground">times</span>
          )}
        </div>
      </div>

      {/* Kept on its own line rather than folded into the wrapping row above,
       * and that is a measured choice -- but NOT for the reason this comment
       * used to give. It claimed the `last` variant's extra height would make
       * it bottom-align under `items-end` and hang its own select a row above
       * its neighbours. Folding it in and measuring every child says that
       * never happens: the window always starts a fresh flex line, where it is
       * the TALLEST item rather than the shortest, because the value box above
       * is full-width and forces the break before the window is reached.
       *
       * What actually breaks is the opposite end. Bottom-aligning the window's
       * amount row drags the word `times` DOWN to meet it -- 66px for `last`,
       * 86px for `absolute`, and not at all for `ever` -- so the row reads
       * "purchase count at least 3 … in the last … times 90 days", with
       * `times` qualifying the window instead of the count. The obstacle is
       * `ValueInput`'s width, not the window's height, and naming the wrong
       * one is how the next person to try making this row read as a sentence
       * loses an afternoon.
       *
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
