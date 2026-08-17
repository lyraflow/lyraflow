import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { ApiClient } from '../../api/client.js'
import type { FunnelStep } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { WherePredicates } from '../segments/WherePredicates.js'
import { EventCombobox } from './EventCombobox.js'

/** A funnel needs at least two steps to mean anything -- one step has no
 * "from" to convert from. Remove is refused once the list is at this floor,
 * the same way Save/Preview refuse the whole form below it. */
export const MIN_STEPS = 2

/**
 * Owns add, remove and reorder for the step list -- the builder itself only
 * ever hands this the current `steps` array and receives the next one back
 * whole, exactly the way `RangePicker` hands back a plain value rather than
 * a delta.
 *
 * Each step also carries its own `where` predicates, narrowing THAT step to
 * the events whose properties match -- "page_view where path is /changelog"
 * rather than every page_view there is. The editor is
 * `../segments/WherePredicates.tsx` unchanged, not a funnel-shaped copy of
 * it: `FunnelStep.where` is the segment `WherePredicate[]` verbatim (core's
 * `funnels/ast.ts` says why), so a second editor would be a second grammar
 * for one idea. It is handed an event NAME and an array; it knows nothing
 * about steps.
 *
 * Steps used to be LOCKED when they carried predicates -- the event field
 * disabled, the predicates listed read-only, and `FunnelBuilder` refusing
 * the whole save -- because a control that could not edit a predicate could
 * only drop it or misrepresent it. Editing them here retires that; there is
 * no `locked` state left anywhere.
 *
 * What survives is the hazard the lock's second half named: changing a
 * step's EVENT leaves predicates written against the old one, and a
 * property that exists on `page_view` may not exist on `signup_started`.
 * They are deliberately kept, not cleared -- clearing is data loss, and an
 * operator mid-edit did not ask for it -- and `PropertyCombobox` re-scopes
 * its suggestions to the new event on the very next lookup, since `event`
 * is one of its lookup dependencies. A predicate naming a property the new
 * event never carries simply matches nothing, which is the same thing that
 * happens for a property no event has recorded YET: this codebase lets a
 * definition be written ahead of the data that fills it, which is why these
 * fields are free-typed rather than picklists.
 */
export function StepRows(props: {
  client: ApiClient
  projectId: number
  steps: FunnelStep[]
  onChange: (steps: FunnelStep[]) => void
  onUnauthorized?: () => void
}) {
  const { client, projectId, steps, onChange, onUnauthorized } = props

  function updateEvent(i: number, event: string) {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, event } : s)))
  }
  // `undefined` means "this step has no predicates", and the KEY is dropped
  // rather than set to `undefined`: `FunnelStep.where` is `.optional()`, so
  // "absent" is the shape a step that never had one is stored with, and a
  // step that had its last predicate removed must round-trip to exactly
  // that -- not to a step carrying an empty-ish field that only looks the
  // same once JSON.stringify has quietly dropped it.
  function updateWhere(i: number, where: WherePredicate[] | undefined) {
    onChange(
      steps.map((s, idx) => {
        if (idx !== i) return s
        const { where: _previous, ...rest } = s
        return where == null ? rest : { ...rest, where }
      }),
    )
  }
  function addStep() {
    onChange([...steps, { event: '' }])
  }
  function removeStep(i: number) {
    if (steps.length <= MIN_STEPS) return
    onChange(steps.filter((_, idx) => idx !== i))
  }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    const tmp = next[i]
    next[i] = next[j] as FunnelStep
    next[j] = tmp as FunnelStep
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {steps.map((step, i) => {
        // `undefined`, never `''`: `PropertyCombobox` treats `undefined` as
        // "suggest across every event" and would otherwise send an empty
        // event name as though it were one, scoping suggestions to an event
        // that does not exist. A step whose event is not yet typed has no
        // scope to offer.
        const scopeEvent = step.event.trim() === '' ? undefined : step.event
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id of their own and this list is reordered/removed by index, matching that index is exactly the identity `moveStep`/`removeStep` need.
            key={i}
            className="flex flex-col gap-1"
          >
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <EventCombobox
                  client={client}
                  projectId={projectId}
                  value={step.event}
                  onUnauthorized={onUnauthorized}
                  onChange={(event) => updateEvent(i, event)}
                  label={`Step ${i + 1}`}
                />
              </div>
              <div className="flex gap-1 pb-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move step ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => moveStep(i, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move step ${i + 1} down`}
                  disabled={i === steps.length - 1}
                  onClick={() => moveStep(i, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={steps.length <= MIN_STEPS}
                  onClick={() => removeStep(i)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {/* `id` is this step's POSITION, which makes each row's test id
             * (`step-2-where-0`) name both the step and the predicate. A
             * single shared id would make "adds to the step you clicked"
             * and "adds to step 1" indistinguishable -- from a test, and
             * from a screen reader. */}
            <WherePredicates
              id={`step-${i + 1}`}
              event={scopeEvent}
              client={client}
              projectId={projectId}
              value={step.where}
              onChange={(where) => updateWhere(i, where)}
              onUnauthorized={onUnauthorized}
            />
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={addStep} className="self-start">
        Add step
      </Button>
    </div>
  )
}
