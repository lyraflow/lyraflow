import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { Segment } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { formatRelative } from './funnels/format.js'
import { summarise } from './segments/summarise.js'

/**
 * `last_count`/`last_evaluated_at` are a CACHE the server writes after each
 * evaluation and never recomputes on read (see `Segment`'s own doc comment
 * in `api/types.ts`) -- a segment that has never been evaluated has
 * `last_evaluated_at === null`, a different fact from a count of zero, and
 * must never render as one. Mirrors `funnelRateLabel` in `Funnels.tsx`.
 */
function segmentCountLabel(s: Segment, now: Date): string {
  if (s.last_evaluated_at === null) return 'Not evaluated yet'
  return `${(s.last_count ?? 0).toLocaleString('en-US')} · ${formatRelative(s.last_evaluated_at, now)}`
}

/** A stale segment's `filter` no longer parses -- passing it to `summarise`
 * and hoping would either throw or read as an empty tree. Mirrors
 * `stepSummary` in `Funnels.tsx`. */
function filterSummary(s: Segment): string {
  if (s.stale) return 'Filter cannot be read'
  return summarise(s.filter as FilterNode)
}

function SegmentRow(props: { segment: Segment }) {
  const { segment } = props
  return (
    <li>
      <Link
        to={segmentPath(segment.id)}
        className="flex flex-col gap-1 rounded-md border border-border bg-card px-4 py-3 hover:bg-muted"
      >
        <span className="font-medium text-foreground">{segment.name}</span>
        <span className="text-sm text-muted-foreground">{filterSummary(segment)}</span>
        {/* `data-testid` exists so a test can assert the count and its
         * timestamp live in the SAME element, not merely both somewhere in
         * the row -- `toHaveTextContent` on the row matches concatenated
         * descendant text, so scoping to the row alone would still pass if
         * a future change split these into sibling spans (fix round 1). */}
        <span className="text-sm text-muted-foreground" data-testid="segment-count">
          {segmentCountLabel(segment, new Date())}
        </span>
      </Link>
    </li>
  )
}

/**
 * The segments list -- fetched once per active project, exactly `Funnels`'
 * and `Settings`' shape (`useEffect` on `[client, activeId]`, a `cancelled`
 * flag, a 401 routed to `onUnauthorized`, everything else to a generic
 * error state).
 *
 * Deliberately does NOT evaluate any segment: the counts shown here are the
 * server's cache as of its last evaluation, not a fresh one, and a list
 * screen silently re-evaluating every segment on every visit would turn a
 * page load into an unbounded number of ClickHouse scans.
 */
export function Segments(props: {
  client: ApiClient
  onUnauthorized?: () => void
}) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [segments, setSegments] = useState<Segment[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setSegments(null)
    setError(false)
    client
      .segments(activeId)
      .then((list) => {
        if (!cancelled) setSegments(list)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, onUnauthorized])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Segments</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.segmentNew}>Create segment</Link>
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load segments. Reload to try again.
        </p>
      )}

      {segments != null && segments.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No segments yet. Create one to filter people by trait or behavior.
        </p>
      )}

      {segments != null && segments.length > 0 && (
        <ul className="flex flex-col gap-2">
          {segments.map((s) => (
            <SegmentRow key={s.id} segment={s} />
          ))}
        </ul>
      )}
    </div>
  )
}
