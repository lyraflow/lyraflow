import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, funnelEditPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import type { RangeDays } from './funnels/RangePicker.js'
import { DEFAULT_RANGE_DAYS, RangePicker, sinceIsoForDays } from './funnels/RangePicker.js'
import { StepBars } from './funnels/StepBars.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import { describeError } from './funnels/errors.js'
import { formatRelative } from './funnels/format.js'

/**
 * A funnel referencing a stale or deleted segment still answers `200` with
 * real, plausible numbers -- computed over the WHOLE population instead of
 * the one it names -- and says so only via a `segment_id` entry in
 * `warnings` (Task 1's probe against a live stack). This is the one place
 * that signal is read; everything downstream of it (whether the segment
 * subtitle renders at all) depends on this, never on `funnel.segment_id`
 * alone.
 */
function segmentFilterBroken(result: FunnelRunResult | null): boolean {
  return result?.warnings.some((w) => w.path === 'segment_id') ?? false
}

/**
 * Runs a saved funnel once on open and renders the result. A range change
 * does NOT re-run it -- it marks the shown numbers stale and waits for an
 * explicit click on "Run". This is a correctness requirement, not styling:
 * the previously-fetched numbers are not an answer to the range now
 * selected, and a chart that keeps showing them under a newly chosen range
 * is a wrong answer presented with confidence. `data-stale` on the result
 * wrapper is how the screen admits that; auto-re-running on every range
 * click would erase the distinction between "this is what you asked for"
 * and "this is what you asked for five clicks ago", exactly the failure
 * mode this screen exists to prevent (see `WarningPanel`'s own doc comment
 * for the segment-filter half of the same problem).
 */
export function FunnelDetail(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const id = params.id == null ? null : Number(params.id)
  const validId = id != null && Number.isSafeInteger(id) ? id : null

  const [funnel, setFunnel] = useState<Funnel | null>(null)
  const [result, setResult] = useState<FunnelRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [stale, setStale] = useState(false)
  const [days, setDays] = useState<RangeDays>(DEFAULT_RANGE_DAYS)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // C1 (whole-branch review): nothing tied a landing response to the range
  // it was actually computed for, so a slow run for one range could resolve
  // AFTER the picker moved on to another and still clear staleness -- the
  // screen would then show the new range in its subtitle (I1) over the old
  // range's numbers, undimmed, with no warning anything was wrong. A ref,
  // not `days` captured in the closure: `days` inside `.then` would still be
  // whatever it was when THIS run started, which is exactly the stale value
  // that can't tell "still selected" from "moved on" -- the ref is mutated
  // by every render, including ones after this promise was created.
  const daysRef = useRef(days)
  useEffect(() => {
    daysRef.current = days
  }, [days])

  // Not scoped to the mount effect's own `cancelled` flag: an explicit Run
  // click happens while the screen is already mounted (it is what the user
  // is looking at when they click it), so there is no unmount race for it
  // to guard against the way there is for the fetches that fire on mount.
  const runNow = useCallback(
    (runDays: RangeDays) => {
      if (activeId == null || validId == null) return
      setRunning(true)
      setError(null)
      const since = sinceIsoForDays(runDays, new Date())
      client
        .runFunnel(activeId, validId, { since })
        .then((r) => {
          // The range picker is deliberately never disabled while a run is
          // in flight (disabling it only hides this race, and would lock
          // the whole screen behind a slow scan) -- so `runDays` and the
          // range selected NOW can genuinely differ by the time this
          // resolves. A response that no longer answers the range currently
          // selected is discarded outright, not merely left dimmed: it is
          // not an answer to anything on screen, and applying it under a
          // stale flag would still let its numbers render as this range's
          // result the instant a later click cleared staleness for an
          // unrelated reason.
          if (runDays !== daysRef.current) return
          setResult(r)
          setStale(false)
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          if (runDays !== daysRef.current) return
          setError(describeError(err))
        })
        .finally(() => setRunning(false))
    },
    [client, activeId, validId, onUnauthorized],
  )

  // Fetch the funnel and run it once for the default range, on mount and
  // whenever the active project or the id in the URL changes. Deliberately
  // NOT depending on `days` -- a range change must dim the result and wait
  // for the explicit Run button, never re-trigger this effect. `runNow` is
  // intentionally left out of the dependency list below: it is recreated
  // only when `activeId`/`validId` change too, which are already this
  // effect's own deps, so listing it would add nothing but a lint-satisfying
  // no-op dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (activeId == null || validId == null) return
    let cancelled = false
    setFunnel(null)
    setResult(null)
    setError(null)
    setStale(false)
    setDays(DEFAULT_RANGE_DAYS)

    client
      .funnel(activeId, validId)
      .then((f) => {
        if (!cancelled) setFunnel(f)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(describeError(err))
      })

    runNow(DEFAULT_RANGE_DAYS)

    return () => {
      cancelled = true
    }
  }, [client, activeId, validId, onUnauthorized])

  const handleRangeChange = (newDays: RangeDays) => {
    setDays(newDays)
    setStale(true)
  }

  // Behind a confirmation, deliberately -- deletion is the one action on
  // this screen with no undo. `deleteError` deliberately does NOT reuse
  // `error` (the run/fetch banner): a failed delete leaves everything else
  // on the page still true, so it gets its own line rather than replacing
  // whatever the run banner was already saying.
  function handleDelete() {
    if (activeId == null || validId == null) return
    setDeleting(true)
    setDeleteError(null)
    client
      .deleteFunnel(activeId, validId)
      .then(() => navigate(ROUTES.funnels))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setDeleteError(describeError(err))
      })
      .finally(() => setDeleting(false))
  }

  const brokenSegment = segmentFilterBroken(result)

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{funnel?.name ?? 'Funnel'}</h1>
        <div className="flex items-center gap-3">
          {/* A funnel whose stored `steps` no longer parse cannot be opened in
           * the builder -- `FunnelBuilder` (Task 6) has nothing to show it.
           * Offering an Edit link the server cannot honour would be its own
           * broken promise. */}
          {funnel != null && !funnel.stale && (
            <Link
              to={funnelEditPath(funnel.id)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Edit
            </Link>
          )}
          {funnel != null && !confirmingDelete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* A second, explicit click behind the first -- deletion has no undo,
       * so this screen never treats one click on "Delete" as consent. */}
      {confirmingDelete && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-foreground">Delete this funnel? This cannot be undone.</p>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              Delete funnel
            </Button>
          </div>
        </div>
      )}

      {deleteError != null && (
        <p role="alert" className="text-sm text-destructive">
          {deleteError}
        </p>
      )}

      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <RangePicker days={days} onChange={handleRangeChange} />
        <Button size="sm" onClick={() => runNow(days)} disabled={running}>
          Run
        </Button>
      </div>

      {result != null && (
        <div
          data-testid="funnel-result"
          data-stale={String(stale)}
          className={`flex min-w-0 flex-col gap-3 ${stale ? 'opacity-50' : ''}`}
        >
          {/* The segment subtitle is INSIDE this block, gated on the SAME
           * `result` it describes -- never on `funnel.segment_id` alone.
           * When `brokenSegment` is true the run went over the whole
           * population, and a header reading "Segment: ..." above those
           * numbers would have the screen contradicting its own warning
           * below. Omitting it entirely, rather than caveating it, is the
           * only rendering that cannot be read as "the filter applied". */}
          {funnel != null && funnel.segment_id != null && !brokenSegment && (
            <p data-testid="funnel-segment-filter" className="text-sm text-muted-foreground">
              Segment: #{funnel.segment_id}
            </p>
          )}
          <WarningPanel warnings={result.warnings} />
          <p className="text-sm text-muted-foreground">
            Last {days} day{days === 1 ? '' : 's'} · as of{' '}
            <span data-testid="funnel-as-of">{formatRelative(result.as_of, new Date())}</span>
          </p>
          <StepBars result={result} />
        </div>
      )}
    </div>
  )
}
