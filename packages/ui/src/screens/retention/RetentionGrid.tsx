import { useEffect, useRef, useState } from 'react'
import type { RetentionResult } from '../../api/types.js'
import { cohortLabel, peakShare, periodLabel, share, tint } from './grid.js'

/**
 * Whether the scroll container has content still to its right, and the ref
 * to attach to that container.
 *
 * `overflow-x-auto` already made the grid scroll; what was missing was any
 * sign that it does (#215). At 390px the table was cut off mid-column with
 * no fade, no shadow and no scrollbar until the reader happened to drag —
 * so a grid that CONTINUES looked like one that had been truncated, which
 * reads as a broken report rather than as more data.
 *
 * Measured rather than inferred from the period count, because whether the
 * grid overflows depends on the viewport, not on the data: 26 periods fits
 * a desktop and 4 does not fit a phone.
 *
 * The ref callback is a fresh function each render, so React re-invokes it
 * on every render and the measurement follows a changed `result` without
 * needing a dependency list — the same shape `usePlotWidth` in
 * `funnels/FunnelFlow.tsx` already relies on, including its jsdom guard.
 */
function useHasMoreRight(): [boolean, (el: HTMLDivElement | null) => void, () => void] {
  const [more, setMore] = useState(false)
  const node = useRef<HTMLDivElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)

  const measure = () => {
    const el = node.current
    if (el == null) return
    // A pixel of slack. A fractional layout width leaves
    // `scrollLeft + clientWidth` a hair under `scrollWidth` at the true end,
    // and without the slack the affordance would pin on permanently at
    // exactly the position it exists to say nothing about — claiming there
    // is always more, which is worse than never claiming it at all.
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1)
  }

  useEffect(() => () => observer.current?.disconnect(), [])

  const ref = (el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    node.current = el
    if (el == null) return
    measure()
    // Guarded: jsdom has no ResizeObserver, and a component that throws on
    // mount there would take every test of this screen with it.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    observer.current = ro
  }

  return [more, ref, measure]
}

/**
 * The grid: one row per cohort, one column per period.
 *
 * A cell that could not be measured renders as an em dash with a title, NOT
 * as `0%`. That distinction is the whole reason this screen is trustworthy —
 * a retention grid whose newest cohorts read 0% because those weeks have not
 * happened yet is the standard way this chart lies, and it lies in exactly
 * the corner a reader scans for a trend.
 *
 * The tint sits behind the text rather than being applied to it, so the
 * strongest cells stay as legible as the weakest: a colour scale that eats
 * its own contrast is the one thing `marketing/brand`'s rules will not
 * trade, and `MAX_TINT` is what keeps this inside them.
 *
 * `overflow-x-auto` on the wrapper, not on the page: 26 periods is a table
 * wider than a laptop by design, and a body that scrolls sideways takes the
 * nav with it. `useHasMoreRight` is what makes that scrolling visible.
 */
export function RetentionGrid(props: { result: RetentionResult }) {
  const { result } = props
  const columns = Array.from({ length: result.periods + 1 }, (_, k) => k)
  // Every cell's shading is drawn against this, not against an absolute
  // 100% -- see `tint`, and the grid that rendered blank because of it.
  const peak = peakShare(result.cohorts)
  const [hasMoreRight, scrollerRef, remeasure] = useHasMoreRight()

  if (result.cohorts.length === 0) {
    return (
      <p data-testid="retention-empty" className="text-sm text-muted-foreground">
        Nobody did <span className="font-medium text-foreground">{result.start_event}</span> in this
        range, so there are no cohorts to measure.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {/* `relative`, so the fade below can sit over the scroller's right
       * edge without scrolling away with the content inside it. */}
      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={remeasure}
          data-testid="retention-grid-scroller"
          className="overflow-x-auto rounded-md border border-input"
        >
          <table className="w-full border-collapse text-sm" data-testid="retention-grid">
            <thead>
              <tr className="border-input border-b">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Cohort
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  People
                </th>
                {columns.map((k) => (
                  <th key={k} scope="col" className="px-3 py-2 text-right font-medium">
                    {periodLabel(k, result.granularity)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.cohorts.map((row) => (
                <tr key={row.cohort} className="border-input border-b last:border-0">
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">
                    {cohortLabel(row.cohort)}
                  </th>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.size}
                  </td>
                  {columns.map((k) => {
                    const cell = row.retained[k] ?? null
                    const pct = share(cell, row.size)
                    if (pct === null) {
                      return (
                        <td
                          key={k}
                          className="px-3 py-2 text-right text-muted-foreground"
                          title="This period had not finished when the grid was computed."
                        >
                          —
                        </td>
                      )
                    }
                    return (
                      <td key={k} className="relative px-3 py-2 text-right tabular-nums">
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 bg-primary"
                          style={{ opacity: tint(pct, peak) }}
                        />
                        <span className="relative">
                          {Math.round(pct)}%
                          <span className="ml-1 text-muted-foreground text-xs">({cell})</span>
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Decoration, so `aria-hidden` — it carries no information a
         * screen reader does not already get from the table itself. It is
         * also purely visual, which leaves the same gap for a keyboard-only
         * reader: the scroll container is not focusable, so there is still
         * no way to reach the later columns without a pointer. Filed
         * separately rather than fixed here, because making it focusable
         * changes the tab order of the whole screen. */}
        {hasMoreRight && (
          <div
            aria-hidden="true"
            data-testid="retention-grid-more"
            className="pointer-events-none absolute inset-y-px right-px w-12 rounded-r-md bg-gradient-to-r from-transparent to-background"
          />
        )}
      </div>
      {/* Said, not left to be inferred. The shading is RELATIVE to the
       * strongest cell and is not linear, so two grids are not comparable by
       * shade -- a reader who assumed otherwise would compare colours across
       * two reports and be wrong. Every cell prints its own percentage, so
       * the number is the measurement and the colour only says where to
       * look. Same shape as the trend panels stating their shared peak. */}
      {peak > 0 && (
        <p data-testid="retention-scale" className="text-muted-foreground text-xs">
          Shading is relative to the strongest cell in this grid ({Math.round(peak)}%), so colours
          are not comparable between two grids. The percentages are.
        </p>
      )}
    </div>
  )
}
