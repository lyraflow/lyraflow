import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment, SegmentPreview } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentEditPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import { formatRelative } from './funnels/format.js'
import { MemberList } from './segments/MemberList.js'
import { summarise } from './segments/summarise.js'

/**
 * Views a saved segment: its filter, its count, and the people it matches.
 *
 * On arrival it shows the server's CACHED count and when that count was taken
 * -- the same pair the list row shows -- and replaces it with a fresh one as
 * soon as a preview lands. See the cached block below for why a screen that
 * showed nothing until Run was worse than uninformative rather than merely
 * empty.
 *
 * Wires Edit (a plain link to `SegmentBuilder`'s edit route -- the
 * rename/tree-update split lives there, not here) and Delete, behind a
 * confirmation, same two-step shape and same reasoning as `FunnelDetail`'s
 * own `handleDelete`: deletion is the one action on this screen with no
 * undo, so a single click on "Delete" is never treated as consent, and a
 * failed delete gets its own `deleteError` line rather than replacing
 * whatever the count/warning banner above was already saying. A stale
 * segment gets no Edit link -- `SegmentBuilder` has nothing to show it,
 * same reasoning `FunnelDetail` uses for a stale funnel's steps -- but IS
 * still deletable, since removing a segment that cannot be read is exactly
 * the recovery path a stale segment leaves.
 *
 * The count follows `SegmentBuilder`'s own cheap/costly split (that
 * component's own doc comment has the full reasoning): a cheap tree
 * previews itself via `previewSavedSegment` the moment the segment is known
 * to be cheap, and a tree carrying a `costWarnings` warning waits for an
 * explicit Run instead. Unlike the builder there is no debounce and no
 * `dirty` gate -- this screen never edits the tree, so "the moment it is
 * known to be cheap" (right after the fetch lands) is the only point that
 * could ever matter, matching `FunnelDetail`'s own auto-run-on-open.
 * `WarningPanel` renders the reason here (rather than per-condition, as
 * `SegmentBuilder` does) because this screen has no per-condition
 * breakdown to point at -- only `summarise`'s one-line prose.
 *
 * Same two-ref request/answer split as `SegmentBuilder`'s `runPreview`,
 * for the same reason (that component's own doc comment): `answerIdRef`
 * also moves the instant the fetch effect starts a NEW segment/project
 * (even before its own preview, if any, is issued), so an in-flight
 * response for the segment/project just navigated away from can never
 * land against this one -- and `requestIdRef` gates `previewing` so an
 * older call settling late can't re-enable Run while a newer one (the new
 * segment's own auto-preview) is still open.
 */
export function SegmentDetail(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const id = params.id == null ? null : Number(params.id)
  const validId = id != null && Number.isSafeInteger(id) ? id : null

  const [segment, setSegment] = useState<Segment | null>(null)
  const [segmentError, setSegmentError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SegmentPreview | null>(null)
  // Bumped every time a preview result is ACCEPTED (never merely issued,
  // and never for a response discarded by the answer-id guard). Feeds
  // `MemberList`'s key below so a re-run resets the people underneath the
  // count. Not `preview.as_of` alone: a cache hit inside the server's TTL
  // reports the SAME stored instant, so keying on it would leave a re-run
  // that did land a fresh response showing the previous run's rows.
  const [previewRun, setPreviewRun] = useState(0)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const requestIdRef = useRef(0)
  const answerIdRef = useRef(0)

  const runPreview = useCallback(() => {
    if (activeId == null || validId == null) return
    const requestId = ++requestIdRef.current
    const answerId = ++answerIdRef.current
    setPreviewing(true)
    setPreviewError(null)
    client
      .previewSavedSegment(activeId, validId)
      .then((r) => {
        if (answerId !== answerIdRef.current) return
        setPreview(r)
        setPreviewRun((n) => n + 1)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (answerId !== answerIdRef.current) return
        setPreviewError('Could not run this segment. Try again.')
      })
      .finally(() => {
        if (requestId !== requestIdRef.current) return
        setPreviewing(false)
      })
  }, [client, activeId, validId, onUnauthorized])

  // Fetch, on mount and whenever the active project or the id in the URL
  // changes -- deliberately not depending on `segment` itself, which this
  // effect alone ever sets.
  useEffect(() => {
    if (activeId == null || validId == null) return
    let cancelled = false
    setSegment(null)
    setSegmentError(null)
    setPreview(null)
    setPreviewError(null)
    // The confirmation belongs to the segment it was opened for. Left
    // standing across a navigation it stays open and simply re-aims: open
    // Delete on one segment, follow a link to another, and the second click
    // -- the one this screen treats as the operator's explicit consent --
    // deletes the segment now in the URL, which they never asked to delete
    // and cannot undo. `deleteError` goes with it; it describes a failure
    // against a segment no longer on screen.
    setConfirmingDelete(false)
    setDeleteError(null)
    // A response for the segment/project navigated away FROM must never
    // land against this one -- bumped here, before this segment's own
    // preview (if any) is even issued, exactly like `SegmentBuilder`'s own
    // `handleRootChange` invalidating an in-flight answer before a new
    // request is issued for what replaced it.
    answerIdRef.current += 1
    client
      .segment(activeId, validId)
      .then((s) => {
        if (cancelled) return
        setSegment(s)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSegmentError('Could not load this segment. Reload to try again.')
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, validId, onUnauthorized])

  const warnings = useMemo(() => {
    if (segment == null || segment.stale) return []
    return costWarnings({ ast_version: AST_VERSION, filter: segment.filter as FilterNode })
  }, [segment])

  // Auto-previews the instant a cheap segment is known -- never for a
  // costly one, and never twice for the same segment (`segment` only
  // changes identity when the fetch above actually lands a NEW one).
  // `runPreview` is stable per (client, activeId, validId), already this
  // effect's own inputs via the segment fetch it reacts to -- listing it
  // would add nothing but a lint-satisfying no-op dependency, same
  // reasoning as `FunnelDetail`'s own mount effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (segment == null || segment.stale || warnings.length > 0) return
    runPreview()
  }, [segment, warnings])

  // Behind a confirmation, deliberately -- see this component's own doc
  // comment. `deleteError` is its own line rather than reusing
  // `segmentError`/`previewError`, same reasoning `FunnelDetail`'s own
  // `handleDelete` gives: a failed delete leaves everything else on the
  // page still true.
  function handleDelete() {
    if (activeId == null || validId == null) return
    setDeleting(true)
    setDeleteError(null)
    client
      .deleteSegment(activeId, validId)
      .then(() => navigate(ROUTES.segments))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setDeleteError('Could not delete this segment. Try again.')
      })
      .finally(() => setDeleting(false))
  }

  if (validId == null) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Segment</h1>
        <p role="alert" className="text-sm text-destructive">
          This segment no longer exists.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{segment?.name ?? 'Segment'}</h1>
        <div className="flex items-center gap-3">
          {/* A stale segment's stored filter cannot be read -- SegmentBuilder
           * has nothing to show it, same reasoning FunnelDetail withholds
           * Edit for a stale funnel's steps. */}
          {segment != null && !segment.stale && (
            <Link
              to={segmentEditPath(segment.id)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Edit
            </Link>
          )}
          {segment != null && !confirmingDelete && (
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
          <p className="text-foreground">Delete this segment? This cannot be undone.</p>
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
              Delete segment
            </Button>
          </div>
        </div>
      )}

      {deleteError != null && (
        <p role="alert" className="text-sm text-destructive">
          {deleteError}
        </p>
      )}

      {segmentError != null && (
        <p role="alert" className="text-sm text-destructive">
          {segmentError}
        </p>
      )}

      {segment?.stale && (
        <p role="alert" className="text-sm text-destructive">
          This segment's stored filter cannot be read.
        </p>
      )}

      {segment != null && !segment.stale && (
        <>
          {/* `data-testid` so a test can assert on the SUMMARY rather than on
           * "somewhere on the page": the cost warnings below name the same
           * event this sentence does, so matching by text alone is ambiguous
           * on exactly the trees worth asserting about. */}
          <p className="text-sm text-muted-foreground" data-testid="segment-detail-summary">
            {summarise(segment.filter as FilterNode)}
          </p>

          <WarningPanel warnings={warnings} />

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={runPreview} disabled={previewing}>
              Run
            </Button>
            {previewError != null && (
              <p role="alert" className="text-sm text-destructive">
                {previewError}
              </p>
            )}
          </div>

          {/* What the row you clicked through from was already showing.
           *
           * Before this, arriving here showed no count at all until a Run
           * landed -- which for a costly segment means until the operator
           * clicks. That is worse than uninformative: the list one click back
           * displayed the number, so a blank detail screen implies the count
           * is unknown when it is merely not fresh. `GET /v1/segments/:id`
           * already returns `last_count`/`last_evaluated_at` (the same
           * `toWire` the list route uses), so this costs no extra request.
           *
           * Withdrawn the moment a real preview lands -- two counts on one
           * screen, one stale, is the conflation the `as of` line below
           * exists to prevent -- and marked as STORED while it is up, since
           * a bare number cannot be told from a fresh one.
           *
           * A segment that has never been evaluated says so rather than
           * rendering `last_count ?? 0`: never evaluated and matched nobody
           * are different facts, and the list already keeps them apart
           * (`segmentCountLabel`, `Segments.tsx`). */}
          {preview == null && (
            <div className="flex min-w-0 flex-col gap-1">
              {segment.last_evaluated_at == null ? (
                <p
                  data-testid="segment-detail-cached-count"
                  className="text-sm text-muted-foreground"
                >
                  Not evaluated yet. Run to count the people in this segment.
                </p>
              ) : (
                <>
                  <p
                    data-testid="segment-detail-cached-count"
                    className="text-2xl font-semibold text-foreground"
                  >
                    {(segment.last_count ?? 0).toLocaleString('en-US')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    stored count, as of{' '}
                    <span data-testid="segment-detail-cached-as-of">
                      {formatRelative(segment.last_evaluated_at, new Date())}
                    </span>
                    . Run to refresh it.
                  </p>
                </>
              )}
            </div>
          )}

          {preview != null && (
            <div className="flex min-w-0 flex-col gap-1">
              <p
                data-testid="segment-detail-count"
                className="text-2xl font-semibold text-foreground"
              >
                {preview.person_count.toLocaleString('en-US')}
              </p>
              {/* This number can be a cache hit up to the server's TTL old
               * -- `previewSavedSegment` deliberately reports the STORED
               * `as_of` on a hit precisely so a client can tell -- and a
               * count with no instant beside it cannot be told apart from
               * a live one. Same treatment as `FunnelDetail`'s own
               * subtitle: `formatRelative` on the result's own `as_of`. */}
              <p className="text-sm text-muted-foreground">
                as of{' '}
                <span data-testid="segment-detail-as-of">
                  {formatRelative(preview.as_of, new Date())}
                </span>
              </p>
            </div>
          )}

          {/* The key remounts `MemberList` -- discarding whatever page it
           * had loaded, including anything in flight -- the same reset
           * `Settings.tsx` uses for `LimitsSection`. `MemberList`'s own doc
           * comment has the full reasoning for why that (rather than a
           * second answer-id ref threaded down into a child) is enough: a
           * response for the segment navigated away from lands against an
           * unmounted component and simply has nowhere to apply itself.
           *
           * Keyed on the RUN as well as the segment. On `validId` alone,
           * clicking Run replaced the count above and left the people below
           * untouched, so the two halves of this screen showed different
           * instants with nothing saying so -- the exact conflation the
           * `as_of` line above exists to prevent, one element lower.
           *
           * Gated on `preview != null` -- there is nothing useful to page
           * through before a count has ever been run once, and on
           * `activeId`/`validId` being non-null so the callback below never
           * has to guess at a project or segment id. */}
          {preview != null && activeId != null && validId != null && (
            <MemberList
              key={`${validId}:${previewRun}`}
              fetchPage={(cursor) =>
                client
                  .previewSavedSegment(activeId, validId, { include: ['members'], cursor })
                  .then((r) => ({
                    members: r.members ?? [],
                    next_cursor: r.next_cursor ?? null,
                    window_exhausted: r.window_exhausted ?? false,
                    // From THIS response, not from the `preview` state above.
                    // That one can be a cache hit up to the server's TTL old
                    // (see its own comment); this one shares an `as_of` with
                    // the members beside it, and the walk's cursor pins both
                    // to that instant (#120).
                    person_count: r.person_count,
                  }))
                  .catch((err: unknown) => {
                    // Same 401 routing every other call on this screen does
                    // -- MemberList still sees a rejection (and shows its
                    // own generic error/Retry) since it has no reason to
                    // know about `ApiError` or `onUnauthorized`, but a
                    // session that actually expired navigates away instead
                    // of reading as "could not load these people".
                    if (err instanceof ApiError && err.status === 401) onUnauthorized?.()
                    throw err
                  })
              }
            />
          )}
        </>
      )}
    </div>
  )
}
