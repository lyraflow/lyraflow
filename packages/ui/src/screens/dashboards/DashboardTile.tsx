import { useEffect, useState } from 'react'
import { type ApiClient, ApiError } from '../../api/client.js'
import type { ResolvedTile } from '../../api/types.js'
import { funnelPath, retentionReportPath, trendReportPath } from '../../app/Router.js'
import { describeError } from '../funnels/errors.js'
import { toRequest } from '../retention/params.js'
import type { RangeChoice } from '../shared/range.js'
import {
  KIND_LABEL,
  TileCard,
  type TileEditActions,
  type TileResult,
  type TileStatus,
} from './TileCard.js'
import type { RunQueue } from './runQueue.js'
import {
  ceilingFor,
  funnelRangeOf,
  reportQuery,
  retentionParamsOf,
  trendParamsOf,
  trendQueryOf,
} from './tileRequest.js'

export type { TileEditActions } from './TileCard.js'

/**
 * Where this tile leads: the report's own screen, opened over the range the
 * dashboard is showing.
 *
 * The range is the point. Landing on the report's default window shows
 * different numbers from the tile that was just clicked, with nothing on the
 * page saying why -- which is worse than not offering the link. The query
 * per kind is `reportQuery`, kept in `tileRequest.ts` with the rest of the
 * "what would that screen ask?" mapping and tested there; the paths are
 * built here because they come from `Router.tsx` (see `AddTilePicker`'s note
 * on that import cycle -- called from a function, never at module scope).
 */
function hrefOf(tile: ResolvedTile, range: RangeChoice): string {
  const query = reportQuery(tile.kind, range)
  switch (tile.kind) {
    case 'trend':
      return `${trendReportPath(tile.report_id)}${query}`
    case 'retention':
      return `${retentionReportPath(tile.report_id)}${query}`
    case 'funnel':
      return `${funnelPath(tile.report_id)}${query}`
  }
}

/**
 * One tile's fetch: runs the request its kind's own screen would run,
 * through the dashboard's shared `RunQueue`, and hands the outcome to
 * `TileCard` as a `TileStatus` for rendering. The request each kind makes is
 * the one its screen makes today, built by the same helpers.
 */
export function DashboardTile(props: {
  client: ApiClient
  projectId: number
  tile: ResolvedTile
  range: RangeChoice
  queue: RunQueue
  editing: boolean
  actions?: TileEditActions
  onUnauthorized?(): void
}) {
  const { client, projectId, tile, range, queue, editing, actions, onUnauthorized } = props
  const [result, setResult] = useState<TileResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const deleted = tile.report === null
  const stale = tile.report?.stale === true
  const ceiling = ceilingFor(tile, range, new Date())
  const shouldRun = !deleted && !stale && ceiling === null

  // `tile` and `range` are listed by IDENTITY, not by a serialised key: the
  // dashboard screen holds both between PATCHes, so a re-render that changes
  // neither (edit mode toggling, a sibling tile moving) re-uses the same
  // objects and this effect does not fire. `shouldRun` collapses the three
  // states that must send nothing.
  //
  // `attempt` is the Retry button, and is the one dependency the effect does
  // not READ -- it exists only to re-fire this effect, which is what Biome
  // objects to. Removing it makes Retry inert: a failed run would show the
  // button and nothing would happen on click, with no test-visible error.
  // The alternative shapes (a callback held in a ref, or `start()` called
  // from both the effect and the handler) move the cancellation bookkeeping
  // out of the effect that owns it, for no behavioural gain.
  //
  // `onUnauthorized` is DELIBERATELY absent. A dashboard renders many of
  // these against one shared queue, so any dependency whose identity changes
  // per render re-issues EVERY tile's query -- and a parent passing an inline
  // `onUnauthorized={() => …}` (the ordinary way to write it) would do
  // exactly that, turning one page view into a query storm that no test in
  // the parent's own file would look wrong. It is only ever a logout route,
  // so the closure being one render old costs nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!shouldRun) return
    let cancelled = false
    setResult(null)
    setError(null)
    const now = new Date()
    const run = async (): Promise<TileResult> => {
      switch (tile.kind) {
        case 'trend': {
          if (!tile.report) throw new Error('unreachable')
          const page = await client.stats(
            projectId,
            trendQueryOf(trendParamsOf(tile.report, range), now),
          )
          return { kind: 'trend', page }
        }
        case 'retention': {
          if (!tile.report) throw new Error('unreachable')
          const r = await client.runRetention(
            projectId,
            toRequest(retentionParamsOf(tile.report, range), now),
          )
          return { kind: 'retention', result: r }
        }
        case 'funnel': {
          const r = await client.runFunnel(projectId, tile.report_id, funnelRangeOf(range, now))
          return { kind: 'funnel', result: r }
        }
      }
    }
    queue
      .run(run)
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        // The tile's OWN noun. `describeError` is the funnel screen's, and
        // its 400/404/409 branches name what went wrong -- unqualified, a
        // trend tile reports "This funnel no longer exists.", which is a
        // message about a report that is not on the screen.
        setError(describeError(err, KIND_LABEL[tile.kind]))
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId, queue, tile, range, attempt, shouldRun])

  const status: TileStatus =
    error !== null
      ? { kind: 'error', message: error }
      : result === null
        ? { kind: 'loading' }
        : { kind: 'result', result }

  return (
    <TileCard
      tile={tile}
      range={range}
      status={status}
      href={deleted ? null : hrefOf(tile, range)}
      editing={editing}
      actions={actions}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  )
}
