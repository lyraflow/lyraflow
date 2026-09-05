import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef } from 'react'
import { Link, type NavigateFunction, useNavigate } from 'react-router'
import type { FunnelRunResult, ResolvedTile, RetentionResult, StatsPage } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'
import { FunnelFlowOrBars } from '../funnels/FunnelFlowOrBars.js'
import { RetentionGrid } from '../retention/RetentionGrid.js'
import type { RangeChoice } from '../shared/range.js'
import { TrendPanels } from '../trends/TrendPanels.js'
import { toSeries } from '../trends/series.js'
import { type TileCeiling, ceilingFor } from './tileRequest.js'

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

export type TileResult =
  | { kind: 'trend'; page: StatsPage }
  | { kind: 'retention'; result: RetentionResult }
  | { kind: 'funnel'; result: FunnelRunResult }

/** What a tile has to show right now. `loading` and `result` are the two
 *  `DashboardTile` ever produces; `busy` (a 429 being waited out, no Retry
 *  button -- retrying is already happening) is the shared page's, and lives
 *  here because the rendering is shared even though no fetcher on this
 *  screen ever reaches it. */
export type TileStatus =
  | { kind: 'loading' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'result'; result: TileResult }

export const KIND_LABEL = {
  trend: 'trend report',
  retention: 'retention report',
  funnel: 'funnel',
} as const

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
export function ceilingText(c: TileCeiling, tile: ResolvedTile): string {
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
 * stale definition, ceiling exceeded, run failed (busy is a seventh, only
 * the shared page ever produces it). Rendering only -- `DashboardTile` (and
 * the shared page's fetcher, later) decide WHAT to fetch and hand this
 * component the outcome as `status`.
 *
 * The funnel renders with no `onSelectStep`, so it is inert: nothing on a
 * dashboard reaches the step-people drill.
 */
export function TileCard(props: {
  tile: ResolvedTile
  range: RangeChoice
  status: TileStatus
  /** `null` makes the tile inert: no title link, no "Open it" link in the
   *  stale state, and no body click. This is the whole switch -- there is
   *  no separate `inert` flag, because every place that needs one already
   *  has a link (or doesn't) to test instead. */
  href: string | null
  editing: boolean
  actions?: TileEditActions
  onRetry(): void
}) {
  const { tile, range, status, href, editing, actions, onRetry } = props

  const deleted = tile.report === null
  const stale = tile.report?.stale === true
  const ceiling = ceilingFor(tile, range, new Date())

  const title = tile.report?.name ?? `${KIND_LABEL[tile.kind]} ${tile.report_id}`

  /**
   * The whole body opens the report, not just the title. Cem, testing this:
   * "when I click on any dashboard section, I must be redirected to that
   * report with the same time frame so that I can deep dive" -- a chart is
   * what a reader points at, and the title is a small target beside it.
   *
   * Three things it is deliberately not. It is not a `role="link"`: the
   * title above IS the link, in the accessibility tree and in the tab
   * order, and a second one over the same destination would put every tile
   * in the tab order twice while announcing the whole chart as its name. It
   * is not live in edit mode -- that is where a tile is widened, moved and
   * removed, and navigating away mid-edit loses the layout being arranged.
   * And it does not fire for a click that started inside a control of its
   * own: the stale state's "Open it" link and the failed state's Retry
   * button both live in this body and both already mean something, so a
   * click landing on either is theirs.
   *
   * No key handler beside `onClick`, and no `tabindex` -- the keyboard path
   * to this destination is the title link above. Biome's
   * `useKeyWithClickEvents` does not reach a click handler passed to a
   * COMPONENT (it reads intrinsic elements only), so this is a decision the
   * linter cannot make for us either way.
   */
  const bodyOpens = !editing && href !== null
  const navigateRef = useRef<NavigateFunction | null>(null)
  // `useCallback` with no dependencies, so `Navigator`'s effect does not
  // re-run on every render of this card.
  const setNavigate = useCallback((nav: NavigateFunction) => {
    navigateRef.current = nav
  }, [])
  const openReport = (e: MouseEvent<HTMLDivElement>) => {
    if (href === null) return
    if ((e.target as Element).closest('a, button') !== null) return
    navigateRef.current?.(href)
  }

  const body = (
    <>
      {deleted ? (
        <p data-testid="tile-deleted" role="alert" className="text-sm text-destructive">
          This {KIND_LABEL[tile.kind]} (id {tile.report_id}) has been deleted.
        </p>
      ) : stale ? (
        <p data-testid="tile-stale" role="alert" className="text-sm text-destructive">
          This report's stored definition cannot be reproduced by this version.{' '}
          {href === null ? null : (
            <>
              <Link to={href} className="underline">
                Open it
              </Link>{' '}
              to see what was saved.
            </>
          )}
        </p>
      ) : ceiling ? (
        <p data-testid="tile-ceiling" className="text-sm text-muted-foreground">
          {ceilingText(ceiling, tile)}
        </p>
      ) : (
        <StatusBody status={status} tile={tile} onRetry={onRetry} />
      )}
    </>
  )

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
          {href === null ? (
            title
          ) : (
            <Link to={href} className="hover:underline">
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
      {/* ONE `CardContent` for both cases, with the handler hoisted into it
       * -- not two branches rendering two different component types at this
       * position. That is what this was, and React treats a change of type
       * at a position as an unmount plus a mount: flipping `editing`
       * rebuilt the entire body, so every chart was thrown away and redrawn
       * and anything holding state inside it (a `ResizeObserver`, a funnel
       * flow's scroll position) went with it. Pinned by
       * `TileCard.test.tsx`'s "does not remount the body when edit mode is
       * toggled", which holds a DOM node by identity across the flip.
       *
       * `useNavigate` is why there is any conditional here at all: it
       * throws outright outside a `<Router>` (react-router's own
       * invariant), and the shared viewer page renders this card with no
       * router -- `href` is `null` there for every tile (see
       * `screens/shared-view/SharedTile.tsx`). A hook cannot be called
       * conditionally, so the call lives in `Navigator`, a child that
       * renders nothing and mounts only when there is somewhere to go. The
       * handler it hands back arrives through a ref, so this element's own
       * type never changes. */}
      <CardContent
        className={`min-w-0${bodyOpens ? ' cursor-pointer' : ''}`}
        onClick={bodyOpens ? openReport : undefined}
      >
        {bodyOpens && <Navigator href={href} onReady={setNavigate} />}
        {body}
      </CardContent>
    </Card>
  )
}

/**
 * Calls `useNavigate` and hands the result up, rendering nothing.
 *
 * It exists only so that the hook is not called when there is no router --
 * see the note at its one call site. Mounted as a child rather than
 * wrapping the body, so that the body's own element identity does not
 * depend on whether the tile leads anywhere.
 */
function Navigator(props: { href: string; onReady(nav: NavigateFunction): void }) {
  const navigate = useNavigate()
  const { onReady } = props
  useEffect(() => {
    onReady(navigate)
  }, [navigate, onReady])
  return null
}

/** The four `TileStatus` kinds, once the tile isn't deleted, stale or over a
 *  ceiling -- split out only to keep the switch's four branches readable
 *  next to each other rather than nested another nine lines into `TileCard`'s
 *  own JSX. */
function StatusBody(props: {
  status: TileStatus
  tile: ResolvedTile
  onRetry(): void
}): ReactNode {
  const { status, tile, onRetry } = props
  switch (status.kind) {
    case 'loading':
      return <Skeleton data-testid="tile-loading" className="h-40 w-full" />
    case 'busy':
      return (
        <p data-testid="tile-busy" className="text-sm text-muted-foreground">
          {status.message}
        </p>
      )
    case 'error':
      return (
        <div data-testid="tile-error" className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {status.message}
          </p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      )
    case 'result': {
      const result = status.result
      return (
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
      )
    }
  }
}
