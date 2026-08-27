import { MAX_OPTIONAL_STEPS } from '@lyraflow/core/funnels/validate.js'
import type { FilterNode, Group, WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { ApiClient } from '../../api/client.js'
import type { FunnelStep } from '../../api/types.js'
import { EventCombobox } from '../../components/EventCombobox.js'
import { Button } from '../../components/ui/button.js'
import { newCondition } from '../segments/GroupCard.js'
import { TreeEditor } from '../segments/TreeEditor.js'
import { WherePredicates } from '../segments/WherePredicates.js'
import { stepSummary } from './stepSummary.js'

/** A funnel needs at least two steps to mean anything -- one step has no
 * "from" to convert from. Remove is refused once the list is at this floor,
 * the same way Save/Preview refuse the whole form below it. */
export const MIN_STEPS = 2

/**
 * The list with `optional` stripped from whatever now sits at either end.
 *
 * `optionalDisabledReason` refuses the toggle BY POSITION, and reordering
 * or removing a step changes positions without touching `optional` -- so
 * `[a, b(optional), c]` plus one click of b's move-down becomes `[a, c,
 * b(optional)]`, a state the toggle itself would never have allowed and
 * cannot undo, because b's toggle is now disabled for being last. The same
 * hole opens at index 0 via move-up, and via a removal that shortens the
 * list onto an optional step. `stepsValid` checks only length and event
 * names, so Save stays enabled and the server answers 400 with no
 * `detail[]` -- `This funnel could not be read: steps`, naming neither
 * rule. Every mutator therefore lands the list already legal rather than
 * leaving `canSave` to catch it: a rejection at save time is a guard firing
 * after the fact, not a rule keeping the state unreachable.
 *
 * The KEY is dropped, never set to `false`, for the reason `updateOptional`
 * spells out: `FunnelStep.optional` is `.optional()`, so a step that never
 * carried one must round-trip as absent. Only a genuinely optional step is
 * rewritten, so a list with nothing to fix is handed through untouched.
 */
function endsRequired(steps: FunnelStep[]): FunnelStep[] {
  return steps.map((s, idx) => {
    if (s.optional !== true) return s
    if (idx !== 0 && idx !== steps.length - 1) return s
    const { optional: _stranded, ...rest } = s
    return rest
  })
}

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
 *
 * A step may also carry an `audience`, gating WHICH PERSON may advance past
 * it -- as opposed to `where`, which gates WHICH OCCURRENCE of the event
 * counts. "page_view where path is /changelog, audience: plan = pro" asks
 * two different questions: `where` narrows the event that arrived; the
 * audience narrows whose event it has to be. It is the segment `FilterNode`
 * verbatim (`FunnelStep.audience`'s own doc comment says why), so it gets
 * the segment builder's own editor, `TreeEditor`, unchanged -- the same
 * relationship `where` already has to `WherePredicates`. Unlike `where`, it
 * is opt-in per step behind an "Add audience"/"Remove audience" pair rather
 * than always rendered: a bare-leaf-or-more tree editor on every one of up
 * to eight steps would bury the event field, still each step's primary
 * content, under editors most steps will never use.
 */
export function StepRows(props: {
  client: ApiClient
  projectId: number
  steps: FunnelStep[]
  onChange: (steps: FunnelStep[]) => void
  onUnauthorized?: () => void
  /** The WHOLE funnel's cost warnings, unfiltered. Filtered per step below;
   * see `stepWarnings`. */
  warnings?: CostWarning[]
  /** Step index -> the editor paths whose node does not parse, from
   * `completeness()`. Computed by the builder, which is where Save is
   * gated on it. */
  incomplete?: Record<number, number[][]>
  /** Which steps are collapsed to a one-line summary.
   *
   * OWNED BY THE BUILDER, like `steps` itself, and that is the whole reason
   * the rule "collapse is decided when the form seeds and never changes
   * because you typed" can hold. Kept here instead, this component would
   * have to guess when a stored funnel had arrived, and the only signals it
   * has are prop changes -- which fire on every keystroke. */
  collapsed?: readonly number[]
  onToggleCollapse?: (index: number) => void
}) {
  const {
    client,
    projectId,
    steps,
    onChange,
    onUnauthorized,
    warnings = [],
    incomplete = {},
    collapsed = [],
    onToggleCollapse,
  } = props

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
  /**
   * Same rule as `updateWhere`: the KEY is dropped rather than set to
   * `undefined`, because `audience` is `.optional()` and "absent" is the
   * shape a step that never had one is stored with. A step whose condition
   * was removed must round-trip to exactly that, not to a step carrying a
   * field that only looks absent once `JSON.stringify` has dropped it.
   */
  function updateAudience(i: number, audience: FilterNode | undefined) {
    onChange(
      steps.map((s, idx) => {
        if (idx !== i) return s
        const { audience: _previous, ...rest } = s
        return audience == null ? rest : { ...rest, audience }
      }),
    )
  }
  /**
   * Same rule as `updateWhere` and `updateAudience`: the KEY is dropped
   * rather than set to `false`. `FunnelStep.optional` is `.optional()`, so
   * "absent" is the shape a step that never had one is stored with, and a
   * step whose toggle was turned back off must round-trip to exactly that --
   * not to a step carrying a field that only looks the same once
   * `JSON.stringify` has quietly dropped it. `stepsEqual` on the server
   * normalises both spellings, but a definition that differs from the one
   * that was saved is still a definition nobody wrote.
   */
  function updateOptional(i: number, optional: boolean) {
    onChange(
      steps.map((s, idx) => {
        if (idx !== i) return s
        const { optional: _previous, ...rest } = s
        return optional ? { ...rest, optional: true } : rest
      }),
    )
  }

  /**
   * This step's warnings, by the `steps.<i>.` prefix `funnelCostWarnings`
   * writes.
   *
   * NOT stripped -- `costWarningPath` (`segments/warnings.ts`) resolves a
   * path by matching `children[N]` segments only, so the prefix is ignored
   * there by construction and a prefixed path already lands on the right
   * row. What genuinely breaks without this filter is attribution BETWEEN
   * steps: step 1's `steps.0.filter.children[0]` and step 2's
   * `steps.1.filter.children[0]` both resolve to the editor path `[0]`, so
   * an unfiltered list renders every warning on every step.
   */
  function stepWarnings(i: number): CostWarning[] {
    return warnings.filter((w) => w.path.startsWith(`steps.${i}.`))
  }

  function addStep() {
    onChange([...steps, { event: '' }])
  }
  function removeStep(i: number) {
    if (steps.length <= MIN_STEPS) return
    onChange(endsRequired(steps.filter((_, idx) => idx !== i)))
  }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    const tmp = next[i]
    next[i] = next[j] as FunnelStep
    next[j] = tmp as FunnelStep
    onChange(endsRequired(next))
  }

  // How many steps are ALREADY optional, funnel-wide -- the cap is on the
  // whole definition, not per step, so every row's disabled check reads the
  // same count.
  const optionalStepCount = steps.filter((s) => s.optional).length

  /**
   * The two rules the server refuses at save must be unreachable here
   * rather than merely rejected: the server's 400 for either one carries no
   * `detail[]`, so `describeError` can only render `This funnel could not
   * be read: steps` -- which names neither rule. Returns the reason to show
   * beside a disabled toggle, or `null` when this step's toggle is enabled.
   *
   * An already-optional step is exempted from the cap check on purpose: an
   * operator must be able to undo their way back under it, not get stuck
   * once it is reached.
   */
  function optionalDisabledReason(i: number, step: FunnelStep): string | null {
    if (i === 0) {
      return 'The first step defines when someone enters the funnel, so it cannot be optional.'
    }
    if (i === steps.length - 1) {
      return 'The last step defines conversion, so it cannot be optional.'
    }
    if (!step.optional && optionalStepCount >= MAX_OPTIONAL_STEPS) {
      return `A funnel may have at most ${MAX_OPTIONAL_STEPS} optional steps.`
    }
    return null
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
        const isCollapsed = collapsed.includes(i)
        const disabledReason = optionalDisabledReason(i, step)
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id of their own and this list is reordered/removed by index, matching that index is exactly the identity `moveStep`/`removeStep` need.
            key={i}
            data-testid={`step-card-${i + 1}`}
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
          >
            {/* The card is the fix. Before it, a step's event, its Where and
             * its audience sat at the same visual level as the NEXT step's,
             * so "where does step 1 end" was answered by reading rather than
             * by an edge -- and the audience's own bordered tree read as a
             * sibling of the step it belongs to rather than as part of it. */}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-expanded={!isCollapsed}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} step ${i + 1}`}
                onClick={() => onToggleCollapse?.(i)}
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
              <span className="text-sm font-semibold">{`Step ${i + 1}`}</span>
              {isCollapsed && (
                <span
                  data-testid={`step-${i + 1}-summary`}
                  className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                  title={stepSummary(step)}
                >
                  {stepSummary(step)}
                </span>
              )}
              <div className={`flex gap-1 ${isCollapsed ? '' : 'ml-auto'}`}>
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

            {!isCollapsed && (
              <>
                <EventCombobox
                  client={client}
                  projectId={projectId}
                  value={step.event}
                  onUnauthorized={onUnauthorized}
                  onChange={(event) => updateEvent(i, event)}
                  label="Event"
                  accessibleName={`Step ${i + 1} event`}
                />
                {/* First/last and the cap are made UNREACHABLE here rather
                 * than rejected at save: the server's 400 for either rule
                 * has no `detail[]`, so `describeError` can only render
                 * `This funnel could not be read: steps`, naming neither
                 * rule. An already-optional step stays enabled past the cap
                 * so an operator can undo their way back under it. */}
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant={step.optional === true ? 'default' : 'outline'}
                    size="sm"
                    className="self-start"
                    aria-pressed={step.optional === true}
                    disabled={disabledReason !== null}
                    onClick={() => updateOptional(i, !step.optional)}
                  >
                    Optional
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {disabledReason ??
                      'People who skip this step still count towards the steps after it. It counts any time after the previous required step, within the window — including after a later step.'}
                  </p>
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
                {/* "audience", not "condition". `GroupCard` renders its own
                 * "Add condition" button INSIDE the editor this control opens,
                 * and two buttons a few pixels apart whose accessible names
                 * differ only by a trailing "to step 1" is an ambiguity for a
                 * screen reader and for every test that addresses a button by
                 * name. The word also carries the distinction the field exists
                 * for: `where` narrows the occurrence, the audience narrows the
                 * person. */}
                {step.audience === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() =>
                      updateAudience(i, { kind: 'group', op: 'and', children: [newCondition()] })
                    }
                  >
                    {`Add audience to step ${i + 1}`}
                  </Button>
                ) : (
                  <div data-testid={`step-${i + 1}-audience`} className="flex flex-col gap-2">
                    <p className="text-sm font-medium">Audience — who may advance past this step</p>
                    {/* `step.audience` is ALREADY NORMALISED -- `FunnelBuilder`
                     * does it at the one point a stored funnel enters its
                     * state, exactly as `SegmentBuilder` does (Task 6), and
                     * every `TreeEditor` edit hands back a group-rooted node.
                     *
                     * DO NOT call `normaliseRoot` here. Normalising at render
                     * reopens the precise seam its own doc comment describes:
                     * `funnelCostWarnings` computes paths against the tree the
                     * SERVER holds, and wrapping a bare leaf at render moves
                     * that leaf from editor path `[]` to `[0]` while the
                     * warning still resolves to `[]`. The warning then lands on
                     * the group instead of the condition it names -- one tree
                     * on screen, another one the paths were computed from,
                     * reconciled nowhere. */}
                    <TreeEditor
                      value={step.audience as Group}
                      onChange={(next) => updateAudience(i, next)}
                      client={client}
                      projectId={projectId}
                      onUnauthorized={onUnauthorized}
                      warnings={stepWarnings(i)}
                      incomplete={incomplete[i] ?? []}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => updateAudience(i, undefined)}
                    >
                      {`Remove audience from step ${i + 1}`}
                    </Button>
                  </div>
                )}
              </>
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
