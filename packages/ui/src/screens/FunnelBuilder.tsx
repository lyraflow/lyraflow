import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { FunnelDefinition, FunnelRunResult, FunnelStep } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, funnelPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { FunnelFlowOrBars } from './funnels/FunnelFlowOrBars.js'
import { SegmentPicker } from './funnels/SegmentPicker.js'
import { StepRows } from './funnels/StepRows.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import type { WindowUnit } from './funnels/WindowField.js'
import { WindowField, secondsToWindowInput, toWindowSeconds } from './funnels/WindowField.js'
import { describeError } from './funnels/errors.js'
import { formatRangeDays, formatRelative } from './funnels/format.js'
import { collapsedOnLoad } from './funnels/stepSummary.js'
import { normaliseRoot } from './segments/TreeEditor.js'
import { completeness } from './segments/warnings.js'

/** A brand-new funnel's starting step list -- one empty step. `StepRows`'
 * own two-step floor governs removal, not the initial count: an operator
 * reaches two steps by clicking "Add step" once, same as this screen's own
 * tests exercise it. */
const NEW_STEPS: FunnelStep[] = [{ event: '' }]
const DEFAULT_WINDOW_VALUE = 7
const DEFAULT_WINDOW_UNIT: WindowUnit = 'days'

/**
 * Creates a new funnel or edits an existing one -- `useParams().id` decides
 * which, exactly the way `FunnelDetail` decides whether to offer an Edit
 * link at all (a stale funnel never gets one, so this screen never has to
 * cope with unparseable stored steps).
 *
 * Preview and Save share ONE base readiness gate (`canSubmit`): at least
 * two steps, every step's event non-empty, and a window that
 * `toWindowSeconds` accepts. Preview is deliberately not ALSO gated on the
 * name field -- an operator previewing a funnel they haven't named yet is
 * a normal, common order of operations, and gating it on the name would
 * make Preview lie about being ready before the numbers ever mattered.
 * Save carries one MORE gate Preview does not: `canSave` additionally
 * requires a non-empty, trimmed name (the server's `CreateBody` is
 * `z.string().min(1).max(200)`, so an unchecked empty or whitespace-only
 * name is a guaranteed 400 for a field the form never marked required) --
 * because only Save can fail outright; Preview never writes anything back.
 *
 * `POST /v1/funnels` needs a FLAT body (`{ name, ...definition }`) --
 * `client.createFunnel` already does that spread internally, so this
 * screen's job is only to call it with three separate arguments, never to
 * nest `definition` under a `definition` key of its own.
 *
 * A successful CREATE lands on the funnels LIST -- there is no result yet
 * to look at, and `Funnels` (which fetches fresh on every mount, no cache
 * above it) is the one place a just-created funnel is confirmed visible,
 * closing the single-source-of-truth gap the previous plan left in the
 * project switcher. A successful EDIT lands on that funnel's own DETAIL
 * page instead (controller ruling, Task 6 fix round 1): the operator just
 * changed steps, window or segment, and the only question they have is
 * what it says now. `FunnelDetail` auto-runs on open, so arriving there
 * answers it immediately -- landing on the list instead would hide the
 * effect of the edit behind another click, on a row showing the OLD
 * cached rate from before the edit, which reads as current when it isn't.
 */
export function FunnelBuilder(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const rawEditId = params.id == null ? null : Number(params.id)
  const editId = rawEditId != null && Number.isSafeInteger(rawEditId) ? rawEditId : null
  const isEditing = editId != null

  const [name, setName] = useState('')
  const [steps, setSteps] = useState<FunnelStep[]>(NEW_STEPS)
  /**
   * Which steps are collapsed to a one-line summary.
   *
   * Owned HERE rather than in `StepRows`, and that ownership is what makes
   * the rule enforceable: collapse is decided when the form seeds and never
   * changes because the operator typed. `StepRows` sees only prop changes,
   * which fire on every keystroke, so it could not tell "a stored funnel
   * just arrived" from "someone pressed a key" -- and a step that folded
   * shut the instant it became valid would move the form under the cursor
   * mid-edit.
   *
   * Indices, matching `steps`. Reorder and removal renumber them, which is
   * handled where those happen rather than by tracking a per-step id nothing
   * else in this form has.
   */
  const [collapsed, setCollapsed] = useState<readonly number[]>([])
  const [windowValue, setWindowValue] = useState(DEFAULT_WINDOW_VALUE)
  const [windowUnit, setWindowUnit] = useState<WindowUnit>(DEFAULT_WINDOW_UNIT)
  const [segmentId, setSegmentId] = useState<number | null>(null)

  // The (project, funnel) pair this form is FOR. Project 1's funnel 7 and
  // project 2's funnel 7 are different funnels, so the id alone is not an
  // identity -- that is precisely the confusion this exists to prevent.
  //
  // `loadedIdentity` is compared against the CURRENT identity during render,
  // so the instant the header project switcher moves, `loaded` is false in
  // that same render -- before the effect has run, and with no window in
  // which the previous funnel's definition is saveable under the new
  // project's id. Set ONLY by a load that succeeded, so a 404 or a 500
  // leaves it false and `canSave` refuses.
  //
  // Mirrors `SegmentBuilder`, where this shape was reproduced end to end:
  // switching project while on an edit route, with the id absent from the
  // new project, left the old project's definition editable with Save
  // enabled, and saving issued a PATCH carrying it against the id in the URL
  // (#119).
  const identity = `${activeId ?? 'none'}:${editId ?? 'new'}`
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  // Create mode has nothing to load; an empty form IS its loaded state.
  const loaded = !isEditing || loadedIdentity === identity

  const [loading, setLoading] = useState(isEditing)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewResult, setPreviewResult] = useState<FunnelRunResult | null>(null)
  // I2 (whole-branch review): spec decision 2 says "changing the range, OR
  // EDITING THE DEFINITION, does not re-run: the chart dims and a Run
  // control appears" -- the detail screen implements the dimming half, but
  // this screen, where a definition is actually being edited, had no
  // staleness concept at all. Previewing 40.8%, then retyping a step, left
  // the old numbers rendered exactly as if they still answered the
  // definition on screen. The definition actually previewed, captured
  // alongside its result, is the one honest reference point: it changes
  // only when a NEW preview is accepted, never when a field is edited.
  const [previewedDefinition, setPreviewedDefinition] = useState<FunnelDefinition | null>(null)

  // The address the FORM belongs to, which is not the same as `identity`.
  // An existing funnel is addressed by project AND id; a funnel that does not
  // exist yet is addressed by the ROUTE alone, because `createFunnel` takes
  // the project as an argument at save time.
  //
  // This distinction is what makes `/funnels/7/edit` -> `/funnels/new` a
  // change: `isEditing` goes false there, so the fetch effect below returns
  // early and would never reset anything. <Routes> reconciles its single
  // child by type and position, so that navigation hands the SAME component
  // instance a new route without remounting it, and the create form opened
  // carrying the funnel just being edited (#119).
  const formIdentity = isEditing ? identity : 'new'
  const resetFormIdentityRef = useRef<string | null>(formIdentity)

  // RESET EVERY DERIVED FIELD WHENEVER THE FORM'S ADDRESS CHANGES, not only
  // when a load succeeds. The fetch effect's `.catch` sets `loadError` and
  // nothing else, so without this a failed load for a new identity left the
  // PREVIOUS funnel's name, steps, window and segment on screen and editable
  // -- one funnel's definition under another funnel's URL.
  //
  // Independent of the `loaded` gate, deliberately, and both are needed: this
  // decides what an operator SEES after a failure, `loaded` decides what they
  // can DO. Either alone leaves a hole -- a reset form with Save live still
  // writes an empty definition over a real funnel, and a gated form still
  // shows someone another project's data.
  //
  // Guarded by a ref rather than left to the dependency array: this must fire
  // when the ADDRESS changes, not merely when the effect re-runs, so an
  // unrelated parent re-render cannot wipe a form the operator is typing in.
  // Declared before the fetch effect so its updates are queued first.
  useEffect(() => {
    if (resetFormIdentityRef.current === formIdentity) return
    resetFormIdentityRef.current = formIdentity
    setName('')
    setSteps(NEW_STEPS)
    setCollapsed([])
    setWindowValue(DEFAULT_WINDOW_VALUE)
    setWindowUnit(DEFAULT_WINDOW_UNIT)
    setSegmentId(null)
    // A preview answers the definition that was on screen a moment ago. It is
    // not about this funnel and must not survive into it.
    setPreviewResult(null)
    setPreviewedDefinition(null)
    setPreviewing(false)
    // Both banners belong to the form being replaced. Left standing, each
    // reports on a funnel that is no longer on screen.
    setLoadError(null)
    setSaveError(null)
    setSaving(false)
  }, [formIdentity])

  // Fetch-and-seed for edit mode only. Deliberately NOT depending on
  // `steps`/`name`/etc: this must run exactly once per (project, id) pair,
  // never re-fire because the operator typed into the very fields it just
  // populated.
  useEffect(() => {
    if (!isEditing || activeId == null || editId == null) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    client
      .funnel(activeId, editId)
      .then((f) => {
        if (cancelled) return
        setName(f.name)
        // Normalised HERE, at the one point a stored definition enters this
        // screen's state -- the same place and for the same reason
        // `SegmentBuilder` does it (see `normaliseRoot`'s own doc comment).
        //
        // A funnel written by the API may carry a bare `behavior`,
        // `trait`, `context`, `lifecycle` or `not` at an audience's root;
        // `GroupCard` addresses a group and would throw on it. Normalising
        // at RENDER instead would be the actual trap: it moves the leaf
        // from editor path `[]` to `[0]` while `funnelCostWarnings` -- which
        // ran against the tree the server holds -- still reports `[]`, so
        // the warning lands on the wrapper rather than on the condition it
        // names. One tree on screen, another the paths came from.
        const seeded = f.steps.length > 0 ? f.steps : NEW_STEPS
        const normalised = seeded.map((s) =>
          s.audience === undefined ? s : { ...s, audience: normaliseRoot(s.audience) },
        )
        setSteps(normalised)
        // THE ONE PLACE collapse is decided. A stored funnel opens with its
        // finished steps folded shut, so an eight-step definition is a list
        // you can read rather than a page you scroll; anything unfinished
        // stays open, because a collapsed row would hide the very field
        // standing between the operator and a saveable funnel.
        setCollapsed(collapsedOnLoad(normalised))
        const win = secondsToWindowInput(f.window_seconds)
        setWindowValue(win.value)
        setWindowUnit(win.unit)
        setSegmentId(f.segment_id)
        // Last, and only here: this is what opens the save gate, so it must
        // never be set by a path that did not actually populate the form.
        setLoadedIdentity(identity)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setLoadError(describeError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, editId, isEditing, identity, onUnauthorized])

  const windowSeconds = toWindowSeconds(windowValue, windowUnit)
  const stepsValid = steps.length >= 2 && steps.every((s) => s.event.trim() !== '')
  /**
   * Every step audience's completeness, in one pass.
   *
   * From core's own schema via `completeness` (`segments/warnings.ts`), not
   * a second hand-written notion of "filled in" -- a second definition of
   * validity is exactly what drifts from the one the server enforces, and
   * the field that drifts is one nobody thought about (a `count` aggregate
   * that must carry no property; a `last` window capped at 3650).
   *
   * `.incomplete` goes down to `StepRows` so the sentence lands on the row
   * that is actually incomplete rather than in a banner up here.
   */
  const audiences = useMemo(() => {
    const incomplete: Record<number, number[][]> = {}
    let allComplete = true
    steps.forEach((s, i) => {
      if (s.audience === undefined) return
      const c = completeness(s.audience)
      if (!c.complete) allComplete = false
      incomplete[i] = c.incomplete
    })
    return { allComplete, incomplete }
  }, [steps])
  const canSubmit = stepsValid && audiences.allComplete && windowSeconds != null && activeId != null
  // The server's `CreateBody` is `z.string().min(1).max(200)` -- a name of
  // only spaces passes THAT check (`min(1)` counts the spaces) but is not a
  // name, so this trims before comparing rather than only checking
  // `name !== ''`. Deliberately its own gate, layered on top of
  // `canSubmit` rather than folded into it: `canSubmit` is Preview's gate
  // too (see this function's own doc comment above), and Preview is
  // deliberately NOT gated on the name field -- a name-empty `canSubmit`
  // would silently start requiring one there as well. Save alone needs
  // `canSave`; `handleSave` repeats this same check below.
  const trimmedName = name.trim()
  // `loaded` is the third term and it is not redundant with `loading`:
  // `loading` is false again the moment a failed fetch settles, while
  // `loaded` stays false until a fetch for THIS identity has actually
  // populated the form. A single `!loading` gate would re-enable Save on
  // exactly the failure this is about.
  const canSave = canSubmit && trimmedName !== '' && loaded
  // There is deliberately no further gate about `where` predicates. Save used
  // to refuse any funnel whose steps carried one, because this screen could
  // represent only a step's event name and a save from here would silently
  // drop the predicate array -- handing the server a step that measures a
  // different population while returning 200. `StepRows` now edits
  // predicates in place and round-trips them through `buildDefinition`
  // untouched, so the loss that gate existed to prevent has no path left to
  // take.

  function buildDefinition(): FunnelDefinition {
    // `windowSeconds` is guaranteed non-null here -- both callers below
    // check `canSubmit` first, which already requires it.
    return { steps, window_seconds: windowSeconds as number, segment_id: segmentId }
  }

  function handlePreview() {
    if (!canSubmit || activeId == null) return
    setPreviewing(true)
    setSaveError(null)
    const definition = buildDefinition()
    client
      .previewFunnel(activeId, definition, {})
      .then((r) => {
        setPreviewResult(r)
        // Captured alongside the result it answers, not before the call --
        // a response that arrives after the definition has already moved on
        // again must not mark THIS newer definition as previewed.
        setPreviewedDefinition(definition)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSaveError(describeError(err))
      })
      .finally(() => setPreviewing(false))
  }

  // I2: stale the instant the definition on screen no longer matches the one
  // the current `previewResult` actually answers -- retyping a step,
  // reordering, changing the window or the segment filter all count, exactly
  // "editing the definition" from decision 2. Deliberately a comparison, not
  // a dirty flag flipped by every onChange: a flag would have to be reset by
  // hand everywhere the definition can change and reintroduce a new copy of
  // the very "which fields did I remember to touch" bug the FunnelDetail
  // fix (C1) exists to avoid on the range side.
  const previewStale =
    previewResult != null &&
    previewedDefinition != null &&
    JSON.stringify(buildDefinition()) !== JSON.stringify(previewedDefinition)

  function handleSave() {
    // Repeats the `canSave` gate already reflected in the button's
    // `disabled` prop below -- deliberately, not redundantly. The button
    // state is what an operator sees; this is what actually stops the
    // request. A mutation that only removes the `disabled` attribute must
    // still find no path to `patchFunnel`/`createFunnel` here.
    if (!canSave || activeId == null) return
    setSaving(true)
    setSaveError(null)
    const definition = buildDefinition()
    // Sent trimmed, not the raw field value: the field can hold leading or
    // trailing whitespace an operator never meant to be part of the name
    // (a stray space from a paste, an accidental trailing keystroke), and
    // the server's own `min(1)` does not strip it -- an untrimmed save
    // would create "Signup " and " Signup" as two different, confusingly
    // near-duplicate funnels rather than normalising to the same one.
    const request =
      isEditing && editId != null
        ? client.patchFunnel(activeId, editId, { name: trimmedName, ...definition })
        : client.createFunnel(activeId, trimmedName, definition)
    request
      // CREATE -> the list (Funnels fetches fresh on every mount, no cache
      // held above it, which is what makes a newly created funnel show up
      // there without a reload). EDIT -> that funnel's own detail page,
      // which auto-runs on open and so is the one place the operator can
      // see the edit actually took, rather than a stale cached rate on a
      // list row.
      .then((funnel) => navigate(isEditing ? funnelPath(funnel.id) : ROUTES.funnels))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSaveError(describeError(err))
      })
      .finally(() => setSaving(false))
  }

  if (isEditing && loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="flex min-w-0 max-w-xl flex-col gap-6">
      <h1 className="text-lg font-semibold">{isEditing ? 'Edit funnel' : 'Create funnel'}</h1>

      {loadError != null && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="funnel-name">Name</Label>
        <Input id="funnel-name" value={name} onChange={(e) => setName(e.target.value)} />
        {/* A 409 (duplicate name) surfaces here, beside the field it names,
         * rather than as a generic page-level banner -- the remedy is
         * "change this field", so the message belongs next to it. */}
        {saveError != null && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
      </div>

      {activeId != null && (
        <StepRows
          client={client}
          projectId={activeId}
          steps={steps}
          onChange={setSteps}
          onUnauthorized={onUnauthorized}
          warnings={previewResult?.warnings ?? []}
          incomplete={audiences.incomplete}
          collapsed={collapsed}
          onToggleCollapse={(i) =>
            setCollapsed((prev) => (prev.includes(i) ? prev.filter((n) => n !== i) : [...prev, i]))
          }
        />
      )}

      <p className="text-sm text-muted-foreground">
        A step condition’s window is measured from now, not from when each person entered the
        funnel. Over an older date range that judges someone against today rather than against their
        own first step.
      </p>

      <WindowField
        value={windowValue}
        unit={windowUnit}
        onChange={(value, unit) => {
          setWindowValue(value)
          setWindowUnit(unit)
        }}
      />

      {activeId != null && (
        <SegmentPicker
          client={client}
          projectId={activeId}
          value={segmentId}
          onChange={setSegmentId}
          onUnauthorized={onUnauthorized}
        />
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handlePreview}
          disabled={!canSubmit || previewing}
        >
          Preview
        </Button>
        <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
          Save
        </Button>
      </div>

      {previewResult != null && (
        <div
          data-testid="builder-preview-result"
          data-stale={String(previewStale)}
          className={`flex min-w-0 flex-col gap-3 ${previewStale ? 'opacity-50' : ''}`}
        >
          <WarningPanel warnings={previewResult.warnings} />
          {/* I3 (whole-branch review): spec §3 requires both `as_of` and the
           * resolved range on a rendered result "so a cached result can
           * never be mistaken for a live one" -- this preview showed
           * neither, unlike the detail screen's subtitle it otherwise
           * mirrors. Sourced from `previewResult.range`/`.as_of`, the SAME
           * fields I1 fixed the detail screen's subtitle to read from, for
           * the same reason: never derived from form state. */}
          <p className="text-sm text-muted-foreground">
            <span data-testid="builder-preview-range">{formatRangeDays(previewResult.range)}</span>{' '}
            · as of{' '}
            <span data-testid="builder-preview-as-of">
              {formatRelative(previewResult.as_of, new Date())}
            </span>
          </p>
          {/* The form's CURRENT steps. Both renderings check each position's
           * event name against the result's own before showing a clause,
           * so editing a step after previewing drops the narrowing rather
           * than labelling last preview's numbers with this edit's
           * predicates. */}
          <FunnelFlowOrBars result={previewResult} definition={steps} />
        </div>
      )}
    </div>
  )
}
