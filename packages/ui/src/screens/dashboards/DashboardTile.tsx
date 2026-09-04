import { type MouseEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { type ApiClient, ApiError } from '../../api/client.js'
import type { FunnelRunResult, ResolvedTile, RetentionResult, StatsPage } from '../../api/types.js'
import { funnelPath, retentionReportPath, trendReportPath } from '../../app/Router.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'
import { FunnelFlowOrBars } from '../funnels/FunnelFlowOrBars.js'
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
  reportQuery,
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
  const navigate = useNavigate()

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
  const href = deleted ? null : hrefOf(tile, range)

  /**
   * The whole body opens the report, not just the title. Cem, testing this:
   * "when I click on any dashboard section, I must be redirected to that
   * report with the same time frame so that I can deep dive" -- a chart is
   * what a reader points at, and the title is a small target beside it.
   *
   * Three things it is deliberately not. It is not a `role="link"`: the
   * title above IS the link, in the accessibility tree and in the tab order,
   * and a second one over the same destination would put every tile in the
   * tab order twice while announcing the whole chart as its name. It is not
   * live in edit mode -- that is where a tile is widened, moved and removed,
   * and navigating away mid-edit loses the layout being arranged. And it
   * does not fire for a click that started inside a control of its own: the
   * stale state's "Open it" link and the failed state's Retry button both
   * live in this body and both already mean something, so a click landing on
   * either is theirs.
   */
  const openReport = (e: MouseEvent<HTMLDivElement>) => {
    if (href === null) return
    if ((e.target as Element).closest('a, button') !== null) return
    navigate(href)
  }
  const bodyOpens = !editing && href !== null

  return (
    <Card
      // `min-w-0` on the card, its content and the result wrapper, so a
      // funnel flow wider than the tile scrolls inside its own
      // `overflow-x-auto` container (`FunnelFlow.tsx`) instead of widening
      // the card.
      //
      // MEASURED, not reasoned: rendered at 1180px against the built
      // stylesheet, a half tile holding a 1120px plot stays 582px wide and
      // the plot scrolls -- and it does so with these classes removed too,
      // because a scroll container's own automatic minimum size is already
      // zero. So they are not what makes today's layout work, and the
      // comment they replace said they were. They stay as the guard for the
      // case that rule does not cover: any box between the card and the
      // plot that is NOT a scroll container -- which is what `tile-result`
      // and `CardContent` are the moment something is added beside the
      // chart.
      className={`min-w-0 ${tile.width === 'full' ? 'sm:col-span-2' : ''}`}
      data-testid={`tile-${tile.kind}-${tile.report_id}`}
    >
      <CardHeader>
        <CardTitle className="min-w-0 break-words">
          {deleted ? (
            title
          ) : (
            <Link to={hrefOf(tile, range)} className="hover:underline">
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
      {/* No key handler beside `onClick`, and no `tabindex` -- the keyboard
       * path to this destination is the title link above, which is already
       * in the tab order and already names the report. Biome's
       * `useKeyWithClickEvents` does not reach a click handler passed to a
       * COMPONENT (it reads intrinsic elements only), so this is a decision
       * the linter cannot make for us either way: see `openReport`. */}
      <CardContent
        className={`min-w-0${bodyOpens ? ' cursor-pointer' : ''}`}
        onClick={bodyOpens ? openReport : undefined}
      >
        {deleted ? (
          <p data-testid="tile-deleted" role="alert" className="text-sm text-destructive">
            This {KIND_LABEL[tile.kind]} (id {tile.report_id}) has been deleted.
          </p>
        ) : stale ? (
          <p data-testid="tile-stale" role="alert" className="text-sm text-destructive">
            This report's stored definition cannot be reproduced by this version.{' '}
            <Link to={hrefOf(tile, range)} className="underline">
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
          <div data-testid="tile-result" className="min-w-0">
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
            {result.kind === 'funnel' && (
              // `FunnelFlowOrBars` at EVERY width, so a funnel on a
              // dashboard is the same picture the funnels screen draws --
              // flow above 768px, bars below, decided by the viewport and
              // nothing else. A half-width tile used to force `StepBars`
              // because the flow is wider than half a grid column; it still
              // is, and the answer is that it scrolls inside the card (see
              // the `min-w-0` note on the `Card` above) rather than that a
              // dashboard shows a different chart from the one the report's
              // own screen shows.
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
