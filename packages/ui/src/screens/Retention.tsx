import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { RetentionReportInput, RetentionResult } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { retentionReportPath } from '../app/Router.js'
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
  hasRetentionDefinitionParams,
  incompletePredicates,
  readRetentionParams,
  toRequest,
  tooManyCohorts,
  whereFromStored,
  writeRetentionParams,
} from './retention/params.js'
import { WherePredicates } from './segments/WherePredicates.js'
import { RangePicker } from './shared/RangePicker.js'
import { rangeIncomplete, readRange } from './shared/range.js'

/** `POST /v1/retention-reports` and `PATCH /v1/retention-reports/:id`'s
 * body -- always these seven fields, never the range. The range is not a
 * column (decision 1 in the saved-reports spec): it is this visit's
 * question, not part of what a retention report IS, and sending it here
 * would be the first step toward storing it despite the schema having
 * nowhere to put it. `segment_id` is round-tripped whole -- this screen has
 * no picker for it, so it is whatever the URL is currently carrying (either
 * nothing, or a stored report's restriction seeded on load). */
function reportBody(p: RetentionParams, name: string): RetentionReportInput {
  return {
    name,
    start_event: p.start,
    return_event: p.return,
    start_where: p.startWhere,
    return_where: p.returnWhere,
    granularity: p.granularity,
    periods: p.periods,
    segment_id: p.segmentId,
  }
}

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
 *
 * Renders at both `/retention/new` and `/retention/:id` (`Router.tsx`) --
 * the SAME component, still entirely URL-as-state. An `:id` adds exactly
 * two things on top of what was already here: seeding the URL from the
 * stored definition on arrival (this doesn't change the URL if it already
 * carries one), and a Save control that creates or updates the stored row.
 * Nothing about how the controls, the run, or the warnings work changes
 * either way -- see the saved-reports spec, decision 6, "the screens change
 * as little as possible."
 */
export function Retention(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const routeParams = useParams<{ id: string }>()
  const rawId = routeParams.id == null ? null : Number(routeParams.id)
  const reportId = rawId != null && Number.isSafeInteger(rawId) ? rawId : null

  const [search, setSearch] = useSearchParams()
  const params = readRetentionParams(search)

  const [result, setResult] = useState<RetentionResult | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [reportError, setReportError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The (project, report) pair this screen is currently open on. Same
  // mechanism `Trends.tsx` uses and for the same reason -- see that
  // screen's own comment on `identity`/`resetIdentityRef`.
  const identity = `${activeId ?? 'none'}:${reportId ?? 'new'}`
  const resetIdentityRef = useRef<string | null>(identity)
  // Guards the load-and-maybe-run effect below so its work happens at most
  // once per identity -- see that effect's own comment.
  const loadedIdentityRef = useRef<string | null>(null)

  useEffect(() => {
    if (resetIdentityRef.current === identity) return
    resetIdentityRef.current = identity
    setName('')
    setReportError(null)
    setSaveError(null)
  }, [identity])

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

  // `p` defaults to the params currently on screen -- the button below calls
  // this with no argument, exactly as before this task. The
  // load-and-maybe-run effect passes an EXPLICIT `p` instead of relying on
  // that default, for the reason `Trends.tsx`'s `run` states in its own
  // comment: `setSearch` (seeding) and this component's own re-render are
  // two independently-scheduled updates, so reading `params` implicitly
  // from that effect would risk firing the very request decision 5 exists
  // to prevent using the PRE-seed defaults. Passing the value computed
  // alongside the seed sidesteps the race by construction.
  const run = useCallback(
    async (p: RetentionParams = params) => {
      if (activeId == null) return
      setRunning(true)
      setError(null)
      try {
        // Resolved at RUN time: a relative range read on mount drifts from
        // "now" the longer the tab stays open.
        setResult(await client.runRetention(activeId, toRequest(p, new Date())))
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : 'That grid could not be computed.')
      } finally {
        setRunning(false)
      }
    },
    [client, activeId, params],
  )

  // Fetch the stored report, seed the URL from it if the URL is not already
  // carrying a definition of its own, and -- THE POINT OF THIS TASK --
  // auto-run exactly once, using the SAME readiness/ceiling checks `ready`
  // above already applies, so a saved report born invalid (decision 5)
  // shows the warning instead of firing the doomed request.
  //
  // Deliberately ONE effect rather than two, for the race `Trends.tsx`'s
  // matching effect documents: splitting "load and seed" from "auto-run"
  // behind a flag risks the auto-run firing on a render where `search` has
  // not yet caught up to the seed this effect just wrote. This version
  // never reads `params` for the run at all; it builds the exact
  // `RetentionParams` the seed decided on and hands it to `run` directly.
  //
  // Guarded by `loadedIdentityRef`, not the dependency array: `run` is a
  // new function every render (it closes over `params`), so listing it here
  // would re-evaluate this effect on every keystroke. Deliberately NOT
  // depending on `search` either -- this must run once per (project,
  // report) pair, never refire because seeding just changed `search` (which
  // would loop).
  //
  // Seeding itself is all-or-nothing, decided by `hasRetentionDefinitionParams`
  // -- every part of the definition together, never one field at a time. A
  // shared link is trusted whole or not at all; splicing the URL's fields
  // with storage's would make the definition on screen come from two places
  // at once. The range is excluded from that check on purpose (decision 1)
  // and is never written here -- only `readRange(prev)` is round-tripped
  // through, unchanged, so a range already in the URL is preserved exactly
  // rather than merely left alone by omission.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (reportId == null || activeId == null) return
    if (loadedIdentityRef.current === identity) return
    loadedIdentityRef.current = identity
    let cancelled = false
    setReportError(null)
    client
      .retentionReport(activeId, reportId)
      .then((r) => {
        if (cancelled) return
        setName(r.name)
        const alreadyDefined = hasRetentionDefinitionParams(search)
        const finalParams: RetentionParams = alreadyDefined
          ? params
          : {
              start: r.start_event,
              return: r.return_event,
              startWhere: whereFromStored(r.start_where),
              returnWhere: whereFromStored(r.return_where),
              granularity: r.granularity,
              periods: r.periods,
              segmentId: r.segment_id,
              range: params.range,
            }
        if (!alreadyDefined) {
          setSearch(
            (prev) => writeRetentionParams(prev, { ...finalParams, range: readRange(prev) }),
            { replace: true },
          )
        }
        const seededUnfinished = incompletePredicates(finalParams)
        const seededOverCap = tooManyCohorts(finalParams, new Date())
        const seededIncompleteRange = rangeIncomplete(finalParams.range)
        if (
          finalParams.start !== '' &&
          finalParams.return !== '' &&
          seededUnfinished === 0 &&
          !seededOverCap &&
          !seededIncompleteRange
        ) {
          run(finalParams)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setReportError('This retention report could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, reportId, onUnauthorized])

  const trimmedName = name.trim()
  const canSave =
    activeId != null &&
    trimmedName !== '' &&
    params.start !== '' &&
    params.return !== '' &&
    unfinished === 0

  const handleSave = useCallback(() => {
    // Repeats the `canSave` gate the button's `disabled` prop already
    // reflects -- deliberately, so a mutation that only removes that
    // attribute still finds no path to `createRetentionReport`/
    // `patchRetentionReport` here.
    if (!canSave || activeId == null) return
    setSaving(true)
    setSaveError(null)
    const body = reportBody(params, trimmedName)
    const request =
      reportId != null
        ? client.patchRetentionReport(activeId, reportId, body)
        : client.createRetentionReport(activeId, body)
    request
      .then((saved) => {
        setName(saved.name)
        // CREATE only: this screen becomes that report's own address, the
        // same way `Trends.tsx` does for a saved trend -- see that
        // screen's own comment on why the current search is carried across
        // rather than left to reset.
        if (reportId == null) {
          navigate(
            { pathname: retentionReportPath(saved.id), search: search.toString() },
            { replace: true },
          )
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          setSaveError('A retention report with that name already exists.')
          return
        }
        setSaveError(
          err instanceof Error ? err.message : 'That retention report could not be saved.',
        )
      })
      .finally(() => setSaving(false))
  }, [canSave, activeId, params, trimmedName, reportId, client, navigate, search, onUnauthorized])

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl">Retention</h1>
        <p className="text-muted-foreground text-sm">
          Of the people who did one thing in a period, how many came back and did another in the
          periods after it.
        </p>
      </header>

      {reportError != null && (
        <p role="alert" className="text-sm text-destructive">
          {reportError}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="retention-name">Name</Label>
          <Input
            id="retention-name"
            className="w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {saveError != null && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

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
        <Button
          type="button"
          // NOT `onClick={run}` -- React hands the click's `SyntheticEvent`
          // to whatever `onClick` is, and `run`'s first parameter is now a
          // `RetentionParams` with a default rather than nothing, so passing
          // the handler directly would hand that event to `p` and every
          // read of `p.start`/`p.granularity` below would throw. The
          // wrapper is what makes this call the zero-argument,
          // default-`params` form -- the same one this button always
          // called.
          onClick={() => run()}
          disabled={!ready || running}
        >
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
