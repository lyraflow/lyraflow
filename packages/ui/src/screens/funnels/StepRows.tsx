import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { ApiClient } from '../../api/client.js'
import type { FunnelStep } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
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
 * A step carrying a `where` predicate was authored by the CLI, not this UI
 * (`FunnelStep`'s own doc comment in `api/types.ts`), and this renders that
 * step's event field disabled rather than editable -- re-saving it through
 * this control would either silently drop the predicate or silently keep
 * showing it as if the now-changed event name still matched what it was
 * written against. It can still be removed entirely (which removes the
 * predicate along with it, not a lossy edit of it) so long as the two-step
 * floor allows it.
 *
 * The predicate itself is listed under the locked step, never hidden --
 * an operator staring at a bare, disabled "page_view" field has no way to
 * tell it means "page_view where path = /pricing" rather than every
 * page_view there is. `FunnelBuilder` is the one that turns `locked`
 * anywhere in this list into a save-wide block; this component's job ends
 * at showing the truth of what each step does.
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
        const locked = (step.where?.length ?? 0) > 0
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
                  disabled={locked}
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
            {/* Shown, never hidden -- see this component's own doc comment.
             * Each predicate renders as its OWN element (`property`/`op` on
             * one span, `value` on another) rather than one joined string,
             * so a test -- or an operator scanning quickly -- can find the
             * exact value a step filters on without parsing a sentence. */}
            {locked && step.where != null && step.where.length > 0 && (
              <ul className="flex flex-col gap-0.5 pl-1 text-xs text-muted-foreground">
                {step.where.map((predicate, pi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: predicates have no stable id of their own; this list is only ever rendered read-only, never reordered or removed by index.
                  <li key={pi}>
                    where <span>{predicate.property}</span> {predicate.op}{' '}
                    <span>{String(predicate.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={addStep} className="self-start">
        Add step
      </Button>
    </div>
  )
}
