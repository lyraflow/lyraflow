import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { FunnelDefinition, FunnelRunResult, FunnelStep } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES } from '../app/Router.js'
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
 * Preview and Save share ONE readiness gate (`canSubmit`): at least two
 * steps, every step's event non-empty, and a window that
 * `toWindowSeconds` accepts. Preview is deliberately not ALSO gated on the
 * name field -- an operator previewing a funnel they haven't named yet is
 * a normal, common order of operations, and gating it on the name would
 * make Preview lie about being ready before the numbers ever mattered.
 * Save carries one MORE gate Preview does not: `hasPredicates` (see below),
 * because only Save can lose data -- Preview never writes anything back.
 *
 * `POST /v1/funnels` needs a FLAT body (`{ name, ...definition }`) --
 * `client.createFunnel` already does that spread internally, so this
 * screen's job is only to call it with three separate arguments, never to
 * nest `definition` under a `definition` key of its own.
 *
 * A successful save -- create or edit -- lands on the funnels LIST, not
 * this funnel's own detail page. That is what lets `Funnels` (which fetches
 * fresh on every mount, no cache above it) be the one place a just-saved
 * funnel is confirmed visible, closing the single-source-of-truth gap the
 * previous plan left in the project switcher.
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
    client
      .previewFunnel(activeId, buildDefinition(), {})
      .then(setPreviewResult)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSaveError(describeError(err))
      })
      .finally(() => setPreviewing(false))
  }

  function handleSave() {
    // Repeats the `hasPredicates` guard already reflected in the button's
    // `disabled` prop below -- deliberately, not redundantly. The button
    // state is what an operator sees; this is what actually stops the
    // request. A mutation that only removes the `disabled` attribute must
    // still find no path to `patchFunnel` here.
    if (!canSubmit || activeId == null || hasPredicates) return
    setSaving(true)
    setSaveError(null)
    const definition = buildDefinition()
    const request =
      isEditing && editId != null
        ? client.patchFunnel(activeId, editId, { name, ...definition })
        : client.createFunnel(activeId, name, definition)
    request
      // Saving lands on the list, not the just-saved funnel's own detail
      // page -- `Funnels` fetches fresh on every mount (no cache held above
      // it), so this is also what makes a funnel created or edited here
      // show up there without a reload.
      .then(() => navigate(ROUTES.funnels))
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
        <StepRows client={client} projectId={activeId} steps={steps} onChange={setSteps} />
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
        <Button type="button" onClick={handleSave} disabled={!canSubmit || saving || hasPredicates}>
          Save
        </Button>
      </div>

      {previewResult != null && (
        <div className="flex min-w-0 flex-col gap-3">
          <WarningPanel warnings={previewResult.warnings} />
          <StepBars result={previewResult} />
        </div>
      )}
    </div>
  )
}
