import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { FunnelDefinition, FunnelRunResult, FunnelStep } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, funnelPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { SegmentPicker } from './funnels/SegmentPicker.js'
import { StepBars } from './funnels/StepBars.js'
import { StepRows } from './funnels/StepRows.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import type { WindowUnit } from './funnels/WindowField.js'
import { WindowField, secondsToWindowInput, toWindowSeconds } from './funnels/WindowField.js'
import { describeError } from './funnels/errors.js'
import { formatRangeDays, formatRelative } from './funnels/format.js'

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
 * Save carries two MORE gates Preview does not: `canSave` additionally
 * requires a non-empty, trimmed name (the server's `CreateBody` is
 * `z.string().min(1).max(200)`, so an unchecked empty or whitespace-only
 * name is a guaranteed 400 for a field the form never marked required),
 * and `hasPredicates` (see below) -- both because only Save can lose data
 * or fail outright; Preview never writes anything back.
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
  const [windowValue, setWindowValue] = useState(DEFAULT_WINDOW_VALUE)
  const [windowUnit, setWindowUnit] = useState<WindowUnit>(DEFAULT_WINDOW_UNIT)
  const [segmentId, setSegmentId] = useState<number | null>(null)

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
        setSteps(f.steps.length > 0 ? f.steps : NEW_STEPS)
        const win = secondsToWindowInput(f.window_seconds)
        setWindowValue(win.value)
        setWindowUnit(win.unit)
        setSegmentId(f.segment_id)
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
  }, [client, activeId, editId, isEditing, onUnauthorized])

  const windowSeconds = toWindowSeconds(windowValue, windowUnit)
  const stepsValid = steps.length >= 2 && steps.every((s) => s.event.trim() !== '')
  const canSubmit = stepsValid && windowSeconds != null && activeId != null
  // The server's `CreateBody` is `z.string().min(1).max(200)` -- a name of
  // only spaces passes THAT check (`min(1)` counts the spaces) but is not a
  // name, so this trims before comparing rather than only checking
  // `name !== ''`. Deliberately its own gate, layered on top of
  // `canSubmit` rather than folded into it: `canSubmit` is Preview's gate
  // too (see this function's own doc comment above), and Preview is
  // deliberately NOT gated on the name field -- a name-empty `canSubmit`
  // would silently start requiring one there as well. Save alone needs
  // `canSave`; `handleSave` repeats this same check below, same shape as
  // the existing `hasPredicates` guard on the line after it.
  const trimmedName = name.trim()
  const canSave = canSubmit && trimmedName !== ''
  // A step carrying a `where` predicate was authored by the CLI -- this
  // screen can only ever represent a step's event name, so a save from
  // here would silently drop the predicate array and hand the server a
  // step that measures a different population, all while returning 200.
  // Disabling ONLY the affected step's event field (as StepRows already
  // does) is not enough: every OTHER field on the same funnel would still
  // save through the very PATCH that drops it. The whole save control is
  // disabled instead, so there is no path from "operator clicks Save" to
  // "predicate silently lost" -- not through the button, and not through
  // `handleSave` itself, which repeats this guard below.
  const hasPredicates = steps.some((s) => (s.where?.length ?? 0) > 0)

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
    // Repeats the `hasPredicates` guard (and now the name guard, via
    // `canSave`) already reflected in the button's `disabled` prop below --
    // deliberately, not redundantly. The button state is what an operator
    // sees; this is what actually stops the request. A mutation that only
    // removes the `disabled` attribute must still find no path to
    // `patchFunnel`/`createFunnel` here.
    if (!canSave || activeId == null || hasPredicates) return
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
        />
      )}

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

      {hasPredicates && (
        <p className="text-sm text-muted-foreground">
          One or more steps above were authored with the CLI and cannot be edited or saved from this
          screen. Edit them with the CLI, or remove the affected step here to continue.
        </p>
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
        <Button type="button" onClick={handleSave} disabled={!canSave || saving || hasPredicates}>
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
          <StepBars result={previewResult} />
        </div>
      )}
    </div>
  )
}
