import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult, Segment } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, funnelEditPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { FunnelFlowOrBars } from './funnels/FunnelFlowOrBars.js'
import type { RangeDays } from './funnels/RangePicker.js'
import { DEFAULT_RANGE_DAYS, RangePicker, sinceIsoForDays } from './funnels/RangePicker.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import { describeError } from './funnels/errors.js'
import { formatRangeDays, formatRelative } from './funnels/format.js'

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
 * How the segment subtitle should read, given what `GET /v1/segments`
 * returned (issue #94). Three states, deliberately distinguished rather than
 * collapsed into one fallback:
 *
 * - Resolved: `segmentId` matches an entry in the list -- render its name,
 *   WITH the id (`Paying customers (#4)`). The id stays visible because it's
 *   what actually appears in the API response and in logs; an operator
 *   cross-referencing either needs it on screen, not just the friendly name.
 * - Not loaded yet, or the lookup itself failed (including a non-401 error)
 *   -- fall back to the bare id rather than blocking rendering or hiding the
 *   subtitle. A failed *lookup* is not the same fact as a *deleted* segment
 *   and must never be presented as one.
 * - Loaded successfully and genuinely absent from the list: `segment_id`
 *   carries no foreign key, deliberately, so this is a designed state (the
 *   segment was deleted elsewhere) and not an edge case -- say so plainly,
 *   in the same words `SegmentPicker` already uses for the same state,
 *   rather than rendering a name it doesn't have or silently reading as "no
 *   filter".
 */
function segmentLabel(
  segmentId: number,
  segments: Segment[],
  loaded: boolean,
  loadError: boolean,
): string {
  if (loaded && !loadError) {
    const match = segments.find((s) => s.id === segmentId)
    if (match != null) return `${match.name} (#${segmentId})`
    return `#${segmentId} -- cannot be resolved (deleted, or unreadable)`
  }
  return `#${segmentId}`
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
  // MINOR (whole-branch review): these were one `error` state shared by the
  // funnel fetch AND every run -- two consequences, both defects. First,
  // `runNow` calling `setError(null)` on every click silently wiped out a
  // funnel-fetch banner that had nothing to do with the run just requested.
  // Second, the two fire concurrently on mount (see the effect below), so a
  // fetch failure alongside a successful run could leave an error banner and
  // a full, confident result rendered together -- the fetch and the run are
  // independent requests and must not share one flag that only the more
  // recent caller gets to clear.
  const [funnelError, setFunnelError] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  // MINOR (whole-branch review): decision 8 gives 404 (`funnel_not_found`,
  // "deleted elsewhere") the remedy "offer the list" -- the generic error
  // banner alone left an operator with a message and no way to act on it.
  // Tracked separately from `funnelError`'s TEXT so the link doesn't have to
  // pattern-match a rendered string to know when to appear.
  const [funnelNotFound, setFunnelNotFound] = useState(false)
  const [running, setRunning] = useState(false)
  const [stale, setStale] = useState(false)
  const [days, setDays] = useState<RangeDays>(DEFAULT_RANGE_DAYS)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Issue #94: resolves `funnel.segment_id` to a name via `GET /v1/segments`.
  // Deliberately three flags, not one -- `segmentLabel` above needs to tell
  // "still loading" and "loaded, but the request itself failed" apart from
  // "loaded fine, and the id is genuinely absent from the list", and a
  // single boolean can't carry that distinction.
  const [segments, setSegments] = useState<Segment[]>([])
  const [segmentsLoaded, setSegmentsLoaded] = useState(false)
  const [segmentsError, setSegmentsError] = useState(false)

  // C1 fix round 2 (targeted re-review): the original guard compared the
  // RANGE a response was issued for against the range now selected -- but
  // range equality is not identity. Two in-flight runs sharing the same
  // range (a project switch that lands back on the default 7-day range,
  // most concretely) were indistinguishable to it, so the older one's
  // numbers could still land and un-dim the screen under the NEW project's
  // heading.
  //
  // Two separate counters, deliberately not one -- they answer two
  // different questions and conflating them either lets a stale response
  // apply, or leaves Run stuck disabled:
  //
  // `requestIdRef` identifies NETWORK CALLS. It is bumped only by `runNow`
  // actually issuing a fetch, and gates `running`: Run may re-enable only
  // when the MOST RECENTLY ISSUED call settles, so two overlapping runs
  // (project switch, `:id` change, or the mount effect racing an explicit
  // Run) can't have the older one's `.finally` re-enable Run while the
  // newer one is still open.
  //
  // `answerIdRef` identifies "the question currently on screen". It is
  // bumped by everything that changes what would count as a valid answer to
  // it -- every `runNow` call AND a bare range selection that issues no
  // request at all (`handleRangeChange`, below) -- and gates whether a
  // settling promise may write `result`/`stale`/`runError`. This is the
  // one that must NOT be `requestIdRef`: if range changes bumped the same
  // counter `running` keys off, an in-flight run abandoned by a range
  // change (a real, spec'd case -- the picker is never disabled mid-run)
  // would leave Run stuck disabled forever, since no later request would
  // ever come along whose `.finally` matches a counter that already moved
  // past it for a reason that issued no request.
  //
  // A response is applied only when its own `answerId`, captured at issue
  // time, still equals `answerIdRef.current` -- i.e. nothing has changed
  // what's being asked since. This is strictly more than the range guard it
  // replaces: it also catches a same-range request from a different call
  // site (project switch), which range equality alone could not.
  const requestIdRef = useRef(0)
  const answerIdRef = useRef(0)

  // Not scoped to the mount effect's own `cancelled` flag: an explicit Run
  // click happens while the screen is already mounted (it is what the user
  // is looking at when they click it), so there is no unmount race for it
  // to guard against the way there is for the fetches that fire on mount.
  const runNow = useCallback(
    (runDays: RangeDays) => {
      if (activeId == null || validId == null) return
      const requestId = ++requestIdRef.current
      const answerId = ++answerIdRef.current
      setRunning(true)
      setRunError(null)
      const since = sinceIsoForDays(runDays, new Date())
      client
        .runFunnel(activeId, validId, { since })
        .then((r) => {
          // Discarded outright, not merely left dimmed, for any response
          // that no longer answers the question on screen: it is not an
          // answer to anything currently shown, and applying it under a
          // stale flag would still let its numbers render as the CURRENT
          // question's result the instant something else cleared staleness
          // for an unrelated reason.
          if (answerId !== answerIdRef.current) return
          setResult(r)
          setStale(false)
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          // Same identity check as the success branch above -- an older
          // request's failure must not set an error for a screen that has
          // already moved on to a different question (a new run, or a bare
          // range change).
          if (answerId !== answerIdRef.current) return
          setRunError(describeError(err))
          // Ruling (targeted re-review): a failed Run does not erase a
          // previously good result -- those numbers are still a true answer
          // to the PREVIOUS question, and the operator needs them on screen,
          // dimmed, to decide how to narrow the range. Reusing `stale`
          // (rather than a second flag) is deliberate: it is already the
          // "these numbers are not a fresh, confirmed answer" signal the
          // dimming and `data-stale` attribute key off.
          setStale(true)
        })
        .finally(() => {
          // An older CALL finishing after a newer one is still open must
          // not re-enable Run: only the call that is ACTUALLY the most
          // recently issued may flip `running` back to false. Deliberately
          // `requestIdRef`, not `answerIdRef` -- a range change alone must
          // not block this: the one outstanding call it abandoned still
          // needs to re-enable Run when it settles, even though its result
          // gets discarded above.
          if (requestId !== requestIdRef.current) return
          setRunning(false)
        })
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
    setFunnelError(null)
    setFunnelNotFound(false)
    setRunError(null)
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
        if (err instanceof ApiError && err.status === 404) setFunnelNotFound(true)
        setFunnelError(describeError(err))
      })

    runNow(DEFAULT_RANGE_DAYS)

    return () => {
      cancelled = true
    }
  }, [client, activeId, validId, onUnauthorized])

  // Issue #94: fetches `GET /v1/segments` only once the open funnel actually
  // names one -- state 1 (no filter, `segment_id === null`) fetches nothing
  // at all, deliberately: a screen that pulls a list it will not use on
  // every funnel view is a cost with no benefit. Keyed on `funnel?.segment_id`
  // rather than the whole `funnel` object so this doesn't refire on every
  // funnel refetch that leaves the filter unchanged, and resets to the
  // "not loaded" state whenever the id (or the active project) changes, so a
  // stale name never carries over onto a different funnel while the new
  // lookup is still in flight.
  useEffect(() => {
    const segmentId = funnel?.segment_id ?? null
    if (activeId == null || segmentId == null) {
      setSegments([])
      setSegmentsLoaded(false)
      setSegmentsError(false)
      return
    }
    let cancelled = false
    setSegmentsLoaded(false)
    setSegmentsError(false)
    client
      .segments(activeId)
      .then((list) => {
        if (cancelled) return
        setSegments(list)
        setSegmentsLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        // A failed lookup falls back to the bare id (`segmentLabel` above) --
        // it must not blank the subtitle, and must not break the rest of the
        // page, which has nothing to do with this fetch.
        setSegmentsLoaded(true)
        setSegmentsError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, funnel?.segment_id, onUnauthorized])

  const handleRangeChange = (newDays: RangeDays) => {
    // Bumps `answerIdRef` even though it issues no request of its own: a
    // range change changes what would count as a valid answer, so any
    // response still in flight for the OLD range must be discarded when it
    // lands, exactly like a response for an abandoned project or funnel id.
    answerIdRef.current += 1
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

  // MINOR (whole-branch review): `/funnels/abc` used to null out `validId`
  // and stop there -- every hook above already guards on it, so nothing
  // fetched, no alert rendered, and the heading fell back to the literal
  // string "Funnel". Decision 8 calls `invalid_funnel_id` "not reachable
  // from the UI; treated as a 404" -- this is that 404, raised client-side
  // for the one way an operator reaches it anyway: a stale bookmark or a
  // hand-edited URL, never a request the server had a chance to answer.
  if (validId == null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Funnel</h1>
        <p role="alert" className="text-sm text-destructive">
          This funnel no longer exists.
        </p>
        <Link to={ROUTES.funnels} className="text-sm font-medium text-primary hover:underline">
          Back to funnels
        </Link>
      </div>
    )
  }

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

      {/* MINOR (whole-branch review): an error banner and a full result used
       * to render together -- the funnel fetch and a run fire concurrently
       * on mount, so a fetch failure alongside a successful run could show
       * "this funnel could not be read" right next to a complete, confident
       * numbers panel. `funnelError` takes priority (without the funnel
       * itself, nothing else on the page -- Edit, Delete, the segment
       * subtitle -- can be trusted either); either error suppresses the
       * result entirely rather than rendering beside it. */}
      {funnelError != null ? (
        <div className="flex flex-col gap-1">
          <p role="alert" className="text-sm text-destructive">
            {funnelError}
          </p>
          {funnelNotFound && (
            <Link to={ROUTES.funnels} className="text-sm font-medium text-primary hover:underline">
              Back to funnels
            </Link>
          )}
        </div>
      ) : (
        runError != null && (
          <p role="alert" className="text-sm text-destructive">
            {runError}
          </p>
        )
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <RangePicker days={days} onChange={handleRangeChange} />
        <Button size="sm" onClick={() => runNow(days)} disabled={running}>
          Run
        </Button>
      </div>

      {/* Ruling (targeted re-review): gating this on `runError == null` too
       * went wider than the finding it was meant to fix -- that finding was
       * about the FUNNEL fetch (no funnel means nothing to show numbers
       * for), not a Run that fails after a good result is already on
       * screen. A failed Run keeps the last good result rendered here,
       * dimmed via `stale` (set in `runNow`'s catch above), beside the
       * error banner -- those numbers are still a true answer to the
       * previous question. Only `funnelError` suppresses the block
       * entirely: without the funnel itself nothing else on the page can be
       * trusted either. */}
      {funnelError == null && result != null && (
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
              Segment: {segmentLabel(funnel.segment_id, segments, segmentsLoaded, segmentsError)}
            </p>
          )}
          <WarningPanel warnings={result.warnings} />
          {/* I1 (whole-branch review): sourced from `result.range`, the
           * range the server actually ran over -- NEVER from `days`, the
           * picker's own state. `days` can move the moment a range is
           * picked, before any run answers it; `result.range` only changes
           * when a NEW result is accepted. Rendering from picker state let
           * the subtitle relabel numbers that were never recomputed for the
           * newly chosen range -- the same gap C1's fix closes for
           * `data-stale`, on the label instead of the dimming. */}
          <p className="text-sm text-muted-foreground">
            <span data-testid="funnel-range-label">{formatRangeDays(result.range)}</span> · as of{' '}
            <span data-testid="funnel-as-of">{formatRelative(result.as_of, new Date())}</span>
          </p>
          {/* The definition's own steps, so a narrowed step reads as one.
           * `funnel` can legitimately still be null here -- the fetch and
           * the run are independent requests -- and `FunnelFlowOrBars` renders no
           * clause at all rather than one it cannot place. */}
          <FunnelFlowOrBars result={result} definition={funnel?.steps} />
        </div>
      )}
    </div>
  )
}
