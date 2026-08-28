import type { RetentionResult } from '../../api/types.js'
import { cohortLabel, periodLabel, share, tint } from './grid.js'

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
 * nav with it.
 */
export function RetentionGrid(props: { result: RetentionResult }) {
  const { result } = props
  const columns = Array.from({ length: result.periods + 1 }, (_, k) => k)

  if (result.cohorts.length === 0) {
    return (
      <p data-testid="retention-empty" className="text-sm text-muted-foreground">
        Nobody did <span className="font-medium text-foreground">{result.start_event}</span> in this
        range, so there are no cohorts to measure.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-md border border-input">
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
                      style={{ opacity: tint(pct) }}
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
  )
}
