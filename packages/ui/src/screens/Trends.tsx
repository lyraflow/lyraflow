import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { ApiClient } from '../api/client.js'
import type { TrendResult } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { EventCombobox } from '../components/EventCombobox.js'
import { Button } from '../components/ui/button.js'
import { Label } from '../components/ui/label.js'
import { RangePicker } from './shared/RangePicker.js'
import { rangeIncomplete, resolveRange } from './shared/range.js'
import { BreakdownPicker } from './trends/BreakdownPicker.js'
import { TrendPanels } from './trends/TrendPanels.js'
import {
  INTERVALS,
  MAX_BUCKETS,
  type TrendParams,
  breakdownIncomplete,
  bucketCount,
  groupByOf,
  readTrendParams,
  tooManyBuckets,
  writeTrendParams,
} from './trends/params.js'
import { toSeries } from './trends/series.js'

const INTERVAL_LABELS: Record<string, string> = {
  '1m': 'by minute',
  '1h': 'by hour',
  '1d': 'by day',
  '1w': 'by week',
}

/**
 * Trends: how many of an event over time, optionally split by something.
 *
 * Held in the URL and run on demand, for the same two reasons the Retention
 * screen states -- a chart is small enough to be a link, and an aggregate is
 * a real scan, so numbers from one definition must never sit under the
 * controls of another.
 */
export function Trends(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [search, setSearch] = useSearchParams()
  const params = readTrendParams(search)

  const [result, setResult] = useState<TrendResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = useCallback(
    (patch: Partial<TrendParams>) => {
      setSearch((prev) => writeTrendParams(prev, { ...readTrendParams(prev), ...patch }), {
        replace: true,
      })
      setResult(null)
      setError(null)
    },
    [setSearch],
  )

  const run = useCallback(async () => {
    if (activeId == null) return
    setRunning(true)
    setError(null)
    try {
      setResult(
        await client.stats(activeId, {
          interval: params.interval,
          // Resolved at RUN time, not at render: a relative range read once
          // on mount would drift from "now" the longer the tab stayed open,
          // and the chart would quietly answer for a window that had moved.
          ...resolveRange(params.range, new Date()),
          ...(params.event === '' ? {} : { event: params.event }),
          ...(groupByOf(params) === undefined ? {} : { group_by: groupByOf(params) }),
        }),
      )
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'That trend could not be computed.')
    } finally {
      setRunning(false)
    }
  }, [client, activeId, params])

  const series = result ? toSeries(result.buckets) : []
  // Recomputed on render rather than memoised against a frozen `now`: the
  // number only has to be right when it is shown.
  const buckets = bucketCount(params, new Date())
  const overCap = tooManyBuckets(params, new Date())
  const incompleteRange = rangeIncomplete(params.range)

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl">Trends</h1>
        <p className="text-muted-foreground text-sm">
          How many of an event over time, and how that splits by a property or a column.
        </p>
      </header>

      {/* `items-end` so the Run button's baseline matches the inputs'. That
       * alignment holds only while every column is the same height, so no
       * control in this row may render a description under itself -- the one
       * that did pushed its own field visibly out of line. Explanations go
       * below the row. */}
      <div data-testid="trend-controls" className="flex flex-wrap items-end gap-3">
        <EventCombobox
          client={client}
          projectId={activeId ?? 0}
          value={params.event}
          onChange={(event) => update({ event })}
          label="Event"
          accessibleName="Event"
          onUnauthorized={onUnauthorized}
        />
        <BreakdownPicker
          id="trend-breakdown"
          client={client}
          projectId={activeId ?? 0}
          event={params.event}
          source={params.source}
          field={params.field}
          onChange={(next) => update(next)}
          onUnauthorized={onUnauthorized}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="trend-interval">Resolution</Label>
          <select
            id="trend-interval"
            aria-label="Resolution"
            value={params.interval}
            onChange={(e) => update({ interval: e.target.value as TrendParams['interval'] })}
            className="h-9 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
          >
            {INTERVALS.map((i) => (
              <option key={i} value={i}>
                {INTERVAL_LABELS[i]}
              </option>
            ))}
          </select>
        </div>
        <RangePicker
          id="trend-range"
          value={params.range}
          onChange={(range) => update({ range })}
        />
        <Button
          type="button"
          onClick={run}
          disabled={running || activeId == null || overCap || incompleteRange}
        >
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>

      {params.source === 'property' && (
        <p className="text-muted-foreground text-sm">
          A key from the event's own properties — whatever your app put in <code>properties</code>{' '}
          when it sent the event.
        </p>
      )}

      {incompleteRange && (
        <p data-testid="trend-range-unfinished" className="text-muted-foreground text-sm">
          Pick both dates, or choose a preset range.
        </p>
      )}

      {overCap && (
        <p data-testid="trend-too-many-buckets" className="text-muted-foreground text-sm">
          That range at this resolution is {buckets?.toLocaleString()} points, above the limit of{' '}
          {MAX_BUCKETS.toLocaleString()}. Pick a coarser resolution or a shorter range.
        </p>
      )}

      {breakdownIncomplete(params) && (
        <p data-testid="trend-incomplete-split" className="text-muted-foreground text-sm">
          Pick a {params.source === 'attribute' ? 'column' : 'property'} to split by, or this will
          run as one line.
        </p>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <TrendPanels series={series} interval={params.interval} />
          {/* The counterpart of the retention grid's "these cells are not
           * zeroes" line: a chart that quietly dropped its long tail is one
           * whose parts do not add up, so the screen says what was folded
           * rather than leaving the reader to notice. */}
          {(result.folded_series ?? 0) > 0 && (
            <p data-testid="trend-folded" className="text-muted-foreground text-sm">
              The {result.folded_series} smallest values are summed together as “(other)”, so the
              panels still add up to the total.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
