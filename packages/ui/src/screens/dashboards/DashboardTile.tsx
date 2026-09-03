import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type ApiClient, ApiError } from '../../api/client.js'
import type { FunnelRunResult, ResolvedTile, RetentionResult, StatsPage } from '../../api/types.js'
import { funnelPath, retentionReportPath, trendReportPath } from '../../app/Router.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'
import { FunnelFlowOrBars } from '../funnels/FunnelFlowOrBars.js'
import { StepBars } from '../funnels/StepBars.js'
import { describeError } from '../funnels/errors.js'
import { RetentionGrid } from '../retention/RetentionGrid.js'
import { toRequest } from '../retention/params.js'
import type { RangeChoice } from '../shared/range.js'
import { TrendPanels } from '../trends/TrendPanels.js'
import { toSeries } from '../trends/series.js'
import type { RunQueue } from './runQueue.js'
import {
  type TileCeiling,
  ceilingFor,
  funnelRangeOf,
  retentionParamsOf,
  trendParamsOf,
  trendQueryOf,
} from './tileRequest.js'

export interface TileEditActions {
  onMoveUp?(): void
  onMoveDown?(): void
  onToggleWidth(): void
  onRemove(): void
  /** Held shut while the dashboard has a `PATCH` in flight. Every one of
   *  these sends the WHOLE tile array as it stands on screen, and the array
   *  on screen is the pre-edit one until the response lands -- so a second
   *  click before then carries the same starting layout and its write
   *  silently replaces the first edit. A disabled button says the screen is
   *  busy; the alternative, queueing, would need an optimistic layout this
   *  screen deliberately does not keep. */
  disabled?: boolean
}

type Result =
  | { kind: 'trend'; page: StatsPage }
  | { kind: 'retention'; result: RetentionResult }
  | { kind: 'funnel'; result: FunnelRunResult }

const KIND_LABEL = {
  trend: 'trend report',
  retention: 'retention report',
  funnel: 'funnel',
} as const

function hrefOf(tile: ResolvedTile): string {
  switch (tile.kind) {
    case 'trend':
      return trendReportPath(tile.report_id)
    case 'retention':
      return retentionReportPath(tile.report_id)
    case 'funnel':
      return funnelPath(tile.report_id)
  }
}

/**
 * The warning shown instead of a run, naming the number that is too large
 * and the limit it passed.
 *
 * The trend case prints the report's STORED interval verbatim (`1m`), never
 * a coarser one that would have fit. A tile that quietly renamed the
 * resolution would be describing a report the operator did not save --
 * `TrendReports.tsx`'s prose labels are private to that module, so the raw
 * value is what there is, and it is the honest one.
 */
function ceilingText(c: TileCeiling, tile: ResolvedTile): string {
  switch (c.kind) {
    case 'buckets':
      return `That range at ${
        tile.kind === 'trend' && tile.report ? tile.report.interval : ''
      } resolution is ${c.count.toLocaleString()} points, above the limit of ${c.max.toLocaleString()}. Pick a shorter range.`
    case 'cohorts':
      return `That range at ${
        tile.kind === 'retention' && tile.report ? tile.report.granularity : ''
      } period is ${c.count.toLocaleString()} cohorts, above the limit of ${c.max}. Pick a shorter range.`
    case 'funnel_days':
      return `Funnels run over at most ${c.max} days. Pick a shorter range.`
  }
}

/**
 * One tile: a `Card` whose header links to the report's own screen and
 * whose body is one of six states -- loading, result, report deleted,
 * stale definition, ceiling exceeded, run failed. The request each kind
 * makes is the one its screen makes today, built by the same helpers, and
 * goes through the dashboard's shared `RunQueue`.
 *
 * The funnel renders with no `onSelectStep`, so it is inert: nothing on a
 * dashboard reaches the step-people drill.
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
  const [result, setResult] = useState<Result | null>(null)
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
    const run = async (): Promise<Result> => {
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

  const title = tile.report?.name ?? `${KIND_LABEL[tile.kind]} ${tile.report_id}`

  return (
    <Card
      className={tile.width === 'full' ? 'sm:col-span-2' : ''}
      data-testid={`tile-${tile.kind}-${tile.report_id}`}
    >
      <CardHeader>
        <CardTitle className="min-w-0 break-words">
          {deleted ? (
            title
          ) : (
            <Link to={hrefOf(tile)} className="hover:underline">
              {title}
            </Link>
          )}
        </CardTitle>
        {editing && actions && (
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={actions.onMoveUp}
              disabled={!actions.onMoveUp || actions.disabled}
            >
              Move up
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={actions.onMoveDown}
              disabled={!actions.onMoveDown || actions.disabled}
            >
              Move down
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={actions.onToggleWidth}
              disabled={actions.disabled}
            >
              {tile.width === 'half' ? 'Full width' : 'Half width'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={actions.onRemove}
              disabled={actions.disabled}
            >
              Remove
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {deleted ? (
          <p data-testid="tile-deleted" role="alert" className="text-sm text-destructive">
            This {KIND_LABEL[tile.kind]} (id {tile.report_id}) has been deleted.
          </p>
        ) : stale ? (
          <p data-testid="tile-stale" role="alert" className="text-sm text-destructive">
            This report's stored definition cannot be reproduced by this version.{' '}
            <Link to={hrefOf(tile)} className="underline">
              Open it
            </Link>{' '}
            to see what was saved.
          </p>
        ) : ceiling ? (
          <p data-testid="tile-ceiling" className="text-sm text-muted-foreground">
            {ceilingText(ceiling, tile)}
          </p>
        ) : error ? (
          <div data-testid="tile-error" className="flex flex-col gap-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : result === null ? (
          <Skeleton data-testid="tile-loading" className="h-40 w-full" />
        ) : (
          <div data-testid="tile-result">
            {result.kind === 'trend' && (
              <TrendPanels
                series={toSeries(result.page.buckets)}
                interval={tile.kind === 'trend' && tile.report ? tile.report.interval : undefined}
              />
            )}
            {result.kind === 'retention' && <RetentionGrid result={result.result} />}
            {/* No `onSelectStep`: a dashboard tile is a picture, not a drill-in.
             * `StepBars`/`FunnelFlow` render no step control at all without it,
             * which is what keeps the step-people call unreachable from here. */}
            {result.kind === 'funnel' && tile.width === 'half' && (
              // `FunnelFlowOrBars` picks its rendering from the VIEWPORT
              // (`useIsWide`), but a half-width tile is sized by its grid
              // column, not the viewport -- at a normal viewport it is under
              // 400px wide, the width `StepBars` was built for. Going through
              // `FunnelFlowOrBars` here would show the flow whenever the
              // viewport itself is wide, clipping a long funnel inside a card
              // half that size. `StepBars` directly, unconditionally.
              <StepBars
                result={result.result}
                definition={tile.kind === 'funnel' && tile.report ? tile.report.steps : null}
              />
            )}
            {result.kind === 'funnel' && tile.width === 'full' && (
              <FunnelFlowOrBars
                result={result.result}
                definition={tile.kind === 'funnel' && tile.report ? tile.report.steps : null}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
