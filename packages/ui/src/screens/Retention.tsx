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
  MAX_COHORTS,
  MAX_PERIODS,
  type RetentionParams,
  cohortCount,
  incompletePredicates,
  readRetentionParams,
  toRequest,
  tooManyCohorts,
  writeRetentionParams,
} from './retention/params.js'
import { WherePredicates } from './segments/WherePredicates.js'
import { RangePicker } from './shared/RangePicker.js'
import { rangeIncomplete } from './shared/range.js'

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

  // A half-built condition blocks the run rather than being dropped from it.
  // Dropping it would quietly measure a WIDER population than the operator
  // built, which is the failure this screen refuses everywhere else.
  const unfinished = incompletePredicates(params)
  const cohorts = cohortCount(params, new Date())
  const overCap = tooManyCohorts(params, new Date())
  const incompleteRange = rangeIncomplete(params.range)
  const ready =
    params.start !== '' &&
    params.return !== '' &&
    activeId != null &&
    unfinished === 0 &&
    !overCap &&
    !incompleteRange

  const run = useCallback(async () => {
    if (activeId == null) return
    setRunning(true)
    setError(null)
    try {
      // Resolved at RUN time: a relative range read on mount drifts from
      // "now" the longer the tab stays open.
      setResult(await client.runRetention(activeId, toRequest(params, new Date())))
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

      {/* Each event is a CARD carrying its own predicates, rather than four
       * controls in one row. `$page where path = /` and `$page where path =
       * /register` is the ordinary question this report exists for, and the
       * two `where` lists are what tell those apart -- putting them in one
       * flat row leaves no way to see which list belongs to which event. */}
      <div className="flex flex-col gap-2 rounded-md border border-input p-3">
        <EventCombobox
          client={client}
          projectId={activeId ?? 0}
          value={params.start}
          onChange={(start) => update({ start })}
          label="They did"
          accessibleName="Start event"
          onUnauthorized={onUnauthorized}
        />
        <WherePredicates
          id="retention-start-where"
          // `undefined`, never `''`: the combobox reports an empty string
          // when cleared, and `WherePredicates` reads `''` as an event named
          // the empty string rather than as "no scoping".
          event={params.start === '' ? undefined : params.start}
          client={client}
          projectId={activeId ?? 0}
          value={params.startWhere}
          onChange={(next) => update({ startWhere: next ?? [] })}
          onUnauthorized={onUnauthorized}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-input p-3">
        <EventCombobox
          client={client}
          projectId={activeId ?? 0}
          value={params.return}
          onChange={(v) => update({ return: v })}
          label="Then came back and did"
          accessibleName="Return event"
          onUnauthorized={onUnauthorized}
        />
        <WherePredicates
          id="retention-return-where"
          event={params.return === '' ? undefined : params.return}
          client={client}
          projectId={activeId ?? 0}
          value={params.returnWhere}
          onChange={(next) => update({ returnWhere: next ?? [] })}
          onUnauthorized={onUnauthorized}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
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
        <RangePicker
          id="retention-range"
          value={params.range}
          onChange={(range) => update({ range })}
        />
        <Button type="button" onClick={run} disabled={!ready || running}>
          {running ? 'Running…' : 'Run'}
        </Button>
      </div>

      {!ready && (
        <p className="text-muted-foreground text-sm">
          Name both events to run a grid. Use <code>*</code> for “any event” — a start of{' '}
          <code>*</code> cohorts people by when you first saw them. Add a condition to either one
          when the same event name means several things: <code>$page</code> where <code>path</code>{' '}
          is <code>/</code>, then <code>$page</code> where <code>path</code> is{' '}
          <code>/register</code>.
        </p>
      )}

      {incompleteRange && (
        <p data-testid="retention-range-unfinished" className="text-muted-foreground text-sm">
          Pick both dates, or choose a preset range.
        </p>
      )}

      {overCap && (
        <p data-testid="retention-too-many-cohorts" className="text-muted-foreground text-sm">
          That range at this period is {cohorts?.toLocaleString()} cohorts, above the limit of{' '}
          {MAX_COHORTS}. Pick a longer period or a shorter range.
        </p>
      )}

      {unfinished > 0 && (
        <p data-testid="retention-unfinished" className="text-muted-foreground text-sm">
          {unfinished === 1
            ? 'One condition is not finished — give it a field and a value, or remove it.'
            : `${unfinished} conditions are not finished — give each a field and a value, or remove it.`}
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
