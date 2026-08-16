import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment, SegmentPreview } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { Button } from '../components/ui/button.js'
import { WarningPanel } from './funnels/WarningPanel.js'
import { MemberList } from './segments/MemberList.js'
import { summarise } from './segments/summarise.js'

/**
 * Views a saved segment: its filter, its live count, and (Task 8) the
 * people it matches.
 *
 * Rename/delete are Task 9's -- still not wired here.
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
  const params = useParams<{ id: string }>()
  const id = params.id == null ? null : Number(params.id)
  const validId = id != null && Number.isSafeInteger(id) ? id : null

  const [segment, setSegment] = useState<Segment | null>(null)
  const [segmentError, setSegmentError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SegmentPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

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
      <h1 className="text-lg font-semibold">{segment?.name ?? 'Segment'}</h1>

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
          <p className="text-sm text-muted-foreground">{summarise(segment.filter as FilterNode)}</p>

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

          {preview != null && (
            <p
              data-testid="segment-detail-count"
              className="text-2xl font-semibold text-foreground"
            >
              {preview.person_count.toLocaleString('en-US')}
            </p>
          )}

          {/* `key={validId}` remounts `MemberList` -- discarding whatever
           * page it had loaded, including anything in flight -- the instant
           * the segment on screen changes, the same reset `Settings.tsx`
           * uses for `LimitsSection`. `MemberList`'s own doc comment has the
           * full reasoning for why that (rather than a second answer-id ref
           * threaded down into a child) is enough: a response for the
           * segment navigated away from lands against an unmounted
           * component and simply has nowhere to apply itself. Gated on
           * `preview != null` -- there is nothing useful to page through
           * before a count has ever been run once, and on `activeId`/
           * `validId` being non-null so the callback below never has to
           * guess at a project or segment id. */}
          {preview != null && activeId != null && validId != null && (
            <MemberList
              key={validId}
              fetchPage={(cursor) =>
                client
                  .previewSavedSegment(activeId, validId, { include: ['members'], cursor })
                  .then((r) => ({
                    members: r.members ?? [],
                    next_cursor: r.next_cursor ?? null,
                    window_exhausted: r.window_exhausted ?? false,
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
