import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { ApiClient } from '../api/client.js'
import type { RetentionResult } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { EventCombobox } from '../components/EventCombobox.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { RetentionGrid } from './retention/RetentionGrid.js'
import { unmeasuredCount } from './retention/grid.js'
import {
  GRANULARITIES,
  MAX_PERIODS,
  type RetentionParams,
  readRetentionParams,
  toRequest,
  writeRetentionParams,
} from './retention/params.js'

/**
 * Retention: of the people who did X in one period, how many did Y in the
 * periods after it.
 *
 * **Held in the URL, not in a store.** A grid is two event names, a
 * granularity and a period count — small enough to be a link, which is what
 * makes it shareable without a save button, a name, a list screen and a
 * second set of CRUD routes. The Feed already holds its window and filter
 * this way.
 *
 * **It does not run on render, and does not re-run when the definition
 * changes.** A grid is a real scan over `events`, so it runs when asked. The
 * same reasoning the funnel screen states for its range: numbers from one
 * definition sitting under the controls of another look entirely normal and
 * are a wrong answer given confidently. So the result is cleared the moment
 * the definition it was computed from stops matching the controls.
 */
export function Retention(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [search, setSearch] = useSearchParams()
  const params = readRetentionParams(search)

  const [result, setResult] = useState<RetentionResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = useCallback(
    (patch: Partial<RetentionParams>) => {
      setSearch((prev) => writeRetentionParams(prev, { ...readRetentionParams(prev), ...patch }), {
        replace: true,
      })
      // The grid on screen was computed from the OLD definition. Keeping it
      // under the new controls is the mistake the funnel screen documents;
      // clearing it is what makes "Run" mean something.
      setResult(null)
      setError(null)
    },
    [setSearch],
  )

  const ready = params.start !== '' && params.return !== '' && activeId != null

  const run = useCallback(async () => {
    if (activeId == null) return
    setRunning(true)
    setError(null)
    try {
      setResult(await client.runRetention(activeId, toRequest(params)))
    } catch (err) {
      setResult(null)
      setError(err instanceof Error ? err.message : 'That grid could not be computed.')
    } finally {
      setRunning(false)
    }
  }, [client, activeId, params])

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl">Retention</h1>
        <p className="text-muted-foreground text-sm">
          Of the people who did one thing in a period, how many came back and did another in the
          periods after it.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <EventCombobox
          client={client}
          projectId={activeId ?? 0}
          value={params.start}
          onChange={(start) => update({ start })}
          label="They did"
          accessibleName="Start event"
          onUnauthorized={onUnauthorized}
        />
        <EventCombobox
          client={client}
          projectId={activeId ?? 0}
          value={params.return}
          onChange={(v) => update({ return: v })}
          label="Then came back and did"
          accessibleName="Return event"
          onUnauthorized={onUnauthorized}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="retention-granularity">Period</Label>
          <select
            id="retention-granularity"
            aria-label="Period"
            value={params.granularity}
            onChange={(e) =>
              update({ granularity: e.target.value as RetentionParams['granularity'] })
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
          >
            {GRANULARITIES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="retention-periods">Periods</Label>
          <Input
            id="retention-periods"
            aria-label="Periods"
            type="number"
            min={1}
            max={MAX_PERIODS}
            value={params.periods}
            onChange={(e) => update({ periods: Number(e.target.value) })}
            className="w-24"
          />
        </div>
        <Button type="button" onClick={run} disabled={!ready || running}>
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>

      {!ready && (
        <p className="text-muted-foreground text-sm">
          Name both events to run a grid. Use <code>*</code> for “any event” — a start of{' '}
          <code>*</code> cohorts people by when you first saw them.
        </p>
      )}

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-3">
          <RetentionGrid result={result} />
          {/* The honesty line. A dash is not a zero, and a reader who does not
           * know that reads the newest cohorts as a collapse. */}
          {unmeasuredCount(result.cohorts) > 0 && (
            <p data-testid="retention-incomplete" className="text-muted-foreground text-sm">
              {unmeasuredCount(result.cohorts)} cells show — because those periods had not finished
              when this ran. They are not zeroes, and they will fill in on their own.
            </p>
          )}
          {result.warnings.map((w) => (
            <p key={w.path} className="text-muted-foreground text-sm">
              {w.reason}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
