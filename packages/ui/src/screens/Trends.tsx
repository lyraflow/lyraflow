import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { TrendReportInput, TrendResult } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, trendReportPath } from '../app/Router.js'
import { EventCombobox } from '../components/EventCombobox.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { WherePredicates } from './segments/WherePredicates.js'
import { RangePicker } from './shared/RangePicker.js'
import { rangeIncomplete, readRange, resolveRange } from './shared/range.js'
import { whereFromStored } from './shared/where.js'
import { BreakdownPicker } from './trends/BreakdownPicker.js'
import { TrendPanels } from './trends/TrendPanels.js'
import {
  INTERVALS,
  MAX_BUCKETS,
  type TrendParams,
  breakdownIncomplete,
  bucketCount,
  groupByOf,
  hasTrendDefinitionParams,
  incompletePredicates,
  readTrendParams,
  sourceAndFieldFromGroupBy,
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

/** `POST /v1/trends` and `PATCH /v1/trends/:id`'s body -- always these four
 * fields, never the range. The range is not a column (decision 1 in the
 * saved-reports spec): it is this visit's question, not part of what a
 * trend IS, and sending it here would be the first step toward storing it
 * despite the schema having nowhere to put it. */
function reportBody(p: TrendParams, name: string): TrendReportInput {
  return {
    name,
    event: p.event,
    interval: p.interval,
    group_by: groupByOf(p) ?? null,
    where: p.where,
  }
}

/**
 * What `handleSave` hands `navigate` on CREATE, and what the load effect
 * below reads back on the far side of it.
 *
 * IMPORTANT from the whole-branch review: `/trends/new` and `/trends/:id`
 * carry different `key`s in `Router.tsx`, so a create-then-navigate is a
 * full remount -- `result` starts back at `null`, and the load effect (which
 * fires whenever `reportId` newly names a report) would otherwise call
 * `run()` again for numbers already sitting on screen a moment before. A
 * grid or chart is a real scan; nobody asked for a second one just because
 * Save happened to remount the screen. Carrying the just-computed result
 * through router state -- rather than, say, skipping the load effect
 * outright -- means the freshly-created report's own address renders with
 * its numbers immediately, with no re-fetch and no flash of "nothing here
 * yet".
 */
interface JustSavedState {
  result: TrendResult
}

/**
 * Trends: how many of an event over time, optionally split by something.
 *
 * Held in the URL and run on demand, for the same two reasons the Retention
 * screen states -- a chart is small enough to be a link, and an aggregate is
 * a real scan, so numbers from one definition must never sit under the
 * controls of another.
 *
 * Renders at both `/trends/new` and `/trends/:id` (`Router.tsx`) -- the SAME
 * component, still entirely URL-as-state. An `:id` adds exactly two things
 * on top of what was already here: seeding the URL from the stored
 * definition on arrival (this doesn't change the URL if it already carries
 * one), and a Save control that creates or updates the stored row. Nothing
 * about how the controls, the run, or the warnings work changes either way
 * -- see the saved-reports spec, decision 6, "the screens change as little
 * as possible."
 */
export function Trends(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams<{ id: string }>()
  const rawId = routeParams.id == null ? null : Number(routeParams.id)
  const reportId = rawId != null && Number.isSafeInteger(rawId) ? rawId : null

  const [search, setSearch] = useSearchParams()
  const params = readTrendParams(search)

  // Seeded from `JustSavedState` when this render is the remount a CREATE's
  // `navigate` just produced -- see that type's own comment. `null` in
  // every other case, exactly as before.
  const [result, setResult] = useState<TrendResult | null>(
    () => (location.state as JustSavedState | null)?.result ?? null,
  )
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [reportError, setReportError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // True once a fetched report comes back `stale: true` -- its stored
  // `where` no longer parses under core's grammar (`TrendReport`'s own
  // docstring in `api/types.ts`). Kept as its own piece of state, same
  // reasoning as `Retention.tsx`'s `stale`: it must survive past the seed
  // effect that discovers it, for as long as this report stays open.
  const [stale, setStale] = useState(false)
  // F1 from the whole-branch review, the single-list version of
  // `Retention.tsx`'s `sidesWithLostPredicates`: a trend has one `where`
  // list rather than retention's two sides, so this is one flag rather than
  // a set. A stale trend's predicates fail to reproduce in one of two ways
  // -- an element that fails core's schema but still LOOKS like a predicate
  // (`looksLikePredicate` in `shared/where.ts`) survives seeding as a real,
  // editable row, and `unfinished` below already counts it and blocks Run
  // and Save until it is fixed or removed. An element that fails
  // `looksLikePredicate` itself is DROPPED by `whereFromStored` before it
  // ever becomes a row -- nothing for `unfinished` to count, so without this
  // flag `canSave` would be true with `where` silently narrower than what
  // was actually stored, and Save would PATCH over the stored predicates
  // with that narrower (possibly empty) list. Set at seed time by comparing
  // the raw stored count against what survived seeding; cleared the moment
  // the operator edits the filter (`update`, below) -- editing IS
  // rebuilding, whether or not the edit happens to repair the exact element
  // that failed to parse.
  const [lostPredicates, setLostPredicates] = useState(false)

  // The (project, report) pair this screen is currently open on. Only
  // matters for navigating directly from one saved report to another
  // without an intervening `/trends` visit (e.g. browser back/forward) --
  // `Router.tsx` gives `/trends/new` and `/trends/:id` DIFFERENT `key`s, so
  // the far more common path (create, then this screen becomes that
  // report) is already a full remount and starts every piece of this
  // state fresh on its own.
  //
  // `confirmingDelete`/`deleteError` are reset here for the same reason
  // `SegmentDetail` resets them on its own id-change effect: this screen
  // stays mounted across a same-route navigation from one saved report to
  // another, so a confirmation left standing would simply re-aim -- Delete
  // this report, follow a link to a different one, and the next click
  // deletes whichever report is now open, which was never confirmed.
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
    setStale(false)
    setLostPredicates(false)
    setConfirmingDelete(false)
    setDeleteError(null)
  }, [identity])

  const update = useCallback(
    (patch: Partial<TrendParams>) => {
      setSearch((prev) => writeTrendParams(prev, { ...readTrendParams(prev), ...patch }), {
        replace: true,
      })
      setResult(null)
      setError(null)
      // F1: editing the filter is "rebuilding" it -- see `lostPredicates`'s
      // own comment. The operator has taken ownership of what `where` now
      // says, which is what makes a subsequent Save an intentional write
      // rather than the load effect's own silent narrowing.
      if ('where' in patch) setLostPredicates(false)
    },
    [setSearch],
  )

  // `p` defaults to the params currently on screen -- the button below
  // calls this with no argument, exactly as before this task. The
  // load-and-maybe-run effect passes an EXPLICIT `p` instead of relying on
  // that default, and that is not a style choice: `setSearch` (seeding)
  // and this component's own re-render are two independently-scheduled
  // updates, so the render in which an auto-run effect could next fire is
  // not guaranteed to be the SAME render in which `search` has caught up
  // to the seed this effect just wrote. Reading `params` implicitly from
  // that effect would risk firing the very request decision 5 exists to
  // prevent using the PRE-seed defaults -- narrower than intended rather
  // than over, but silently wrong either way, and this task's whole point
  // is to get exactly this moment right. Passing the value computed
  // alongside the seed sidesteps the race by construction.
  const run = useCallback(
    async (p: TrendParams = params) => {
      if (activeId == null) return
      setRunning(true)
      setError(null)
      try {
        setResult(
          await client.stats(activeId, {
            interval: p.interval,
            // Resolved at RUN time, not at render: a relative range read once
            // on mount would drift from "now" the longer the tab stayed open,
            // and the chart would quietly answer for a window that had moved.
            ...resolveRange(p.range, new Date()),
            ...(p.event === '' ? {} : { event: p.event }),
            ...(groupByOf(p) === undefined ? {} : { group_by: groupByOf(p) }),
            // Omitted entirely when empty -- an empty list is a filter that
            // matches everything, and saying so in every request URL is
            // noise a reader has to discount.
            ...(p.where.length === 0 ? {} : { where: JSON.stringify(p.where) }),
          }),
        )
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : 'That trend could not be computed.')
      } finally {
        setRunning(false)
      }
    },
    [client, activeId, params],
  )

  // Fetch the stored report, seed the URL from it if the URL is not
  // already carrying a definition of its own, and -- THE POINT OF THIS
  // TASK -- auto-run exactly once, gated on every check the Run button's
  // `disabled` prop applies (the ceiling check, the range check, the
  // unfinished-predicate count) PLUS ONE THE BUTTON DOES NOT: staleness.
  // The two are deliberately different. Run stays enabled on a stale
  // report -- its predicates could not be faithfully reproduced, but the
  // banner already says so, and the operator can still press Run to see
  // what the current, possibly narrower, controls compute. The auto-run
  // has no operator standing in front of it deciding to accept that
  // narrower answer, so it does not fire one on their behalf.
  //
  // F2 from the whole-branch review: before that fix, this effect checked
  // only the ceiling and the range -- the unfinished count and staleness
  // were both missing, so a stale report whose predicate survived seeding
  // as an unfinished row (an unknown operator, say) fired the request
  // anyway and showed a raw `invalid_where` under the chart. The comment
  // at the time claimed only the ceiling check was applied, which was
  // itself already wrong about the range check the code already had.
  //
  // Deliberately ONE effect rather than two. An earlier version split
  // "load and seed" from "auto-run" behind a `readyToRun` flag, and that
  // was a real, caught bug: `setSearch` and this component's local state
  // are updated through two different mechanisms, so the render where
  // `readyToRun` first turns true is not guaranteed to be the render where
  // `search` already reflects the seed -- an auto-run effect reading
  // `params` from the URL could fire against the pre-seed defaults. This
  // version never reads `params` for the run at all; it builds the exact
  // `TrendParams` the seed decided on and hands it to `run` directly (see
  // `run`'s own comment), so there is nothing left to race.
  //
  // Guarded by `loadedIdentityRef`, not the dependency array: `run` is a
  // new function every render (it closes over `params`), so listing it
  // here would re-evaluate this effect on every keystroke. Deliberately
  // NOT depending on `search` either -- this must run once per (project,
  // report) pair, never refire because seeding just changed `search`
  // (which would loop).
  //
  // Seeding itself is all-or-nothing, decided by `hasTrendDefinitionParams`
  // -- event, interval, source and field together, never one at a time. A
  // shared link is trusted whole or not at all; splicing the URL's fields
  // with storage's would make the definition on screen come from two
  // places at once, which is the "second source of truth" this task's own
  // brief says to avoid. The range is excluded from that check on purpose
  // (decision 1: it was never stored, so it is not part of what "already
  // has a definition" means) and is never written here -- only
  // `readRange(prev)` is round-tripped through, unchanged, so a range
  // already in the URL is preserved exactly rather than merely left alone
  // by omission.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (reportId == null || activeId == null) return
    if (loadedIdentityRef.current === identity) return
    loadedIdentityRef.current = identity
    let cancelled = false
    setReportError(null)
    // I2 from the whole-branch review. A CREATE's `navigate` (in
    // `handleSave` below) leaves THIS render's `location` carrying
    // `JustSavedState` -- read fresh here rather than off a ref frozen at
    // mount, so this is right whether or not this identity change happens
    // to be a full remount. Consumed at most once: cleared from history
    // right away so a later reload of this exact address (which keeps
    // whatever `history.state` is current) runs the query for real rather
    // than replaying these results forever.
    const justSaved = (location.state as JustSavedState | null)?.result != null
    if (justSaved) {
      navigate(
        { pathname: location.pathname, search: location.search },
        { replace: true, state: null },
      )
    }
    client
      .trendReport(activeId, reportId)
      .then((r) => {
        if (cancelled) return
        setName(r.name)
        setStale(r.stale)
        const alreadyDefined = hasTrendDefinitionParams(search)
        let finalParams: TrendParams
        if (alreadyDefined) {
          finalParams = params
        } else {
          const seededWhere = whereFromStored(r.where)
          // F1: `whereFromStored` silently drops any stored element that
          // does not even look like a predicate (see `lostPredicates`'s own
          // comment) -- comparing the raw stored count against what
          // survived is how this notices, without `whereFromStored` itself
          // needing to change (it is also used to read a hand-edited URL,
          // where silently degrading garbage is the correct behaviour).
          if (seededWhere.length < r.where.length) setLostPredicates(true)
          finalParams = {
            event: r.event,
            interval: r.interval,
            ...sourceAndFieldFromGroupBy(r.group_by),
            where: seededWhere,
            range: params.range,
          }
        }
        if (!alreadyDefined) {
          setSearch((prev) => writeTrendParams(prev, { ...finalParams, range: readRange(prev) }), {
            replace: true,
          })
        }
        const seededUnfinished = incompletePredicates(finalParams)
        // `justSaved` skips exactly the query this task exists to stop
        // repeating -- the results it protects are already in `result`,
        // seeded by this same render's lazy `useState` initializer above.
        if (
          !justSaved &&
          !tooManyBuckets(finalParams, new Date()) &&
          !rangeIncomplete(finalParams.range) &&
          seededUnfinished === 0 &&
          !r.stale
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
        setReportError('This trend could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, reportId, onUnauthorized])

  const series = result ? toSeries(result.buckets) : []
  // Recomputed on render rather than memoised against a frozen `now`: the
  // number only has to be right when it is shown.
  const buckets = bucketCount(params, new Date())
  const overCap = tooManyBuckets(params, new Date())
  const incompleteRange = rangeIncomplete(params.range)
  const unfinished = incompletePredicates(params)

  const trimmedName = name.trim()
  const canSave =
    activeId != null &&
    trimmedName !== '' &&
    params.event !== '' &&
    !breakdownIncomplete(params) &&
    unfinished === 0 &&
    // F1: a saved report whose stored predicates were silently narrowed on
    // load must not be saved as-is -- that would overwrite the stored
    // `where` with the narrower list. See `lostPredicates`'s own comment.
    !lostPredicates

  const handleSave = useCallback(() => {
    // Repeats the `canSave` gate the button's `disabled` prop already
    // reflects -- deliberately, so a mutation that only removes that
    // attribute still finds no path to `createTrendReport`/
    // `patchTrendReport` here.
    if (!canSave || activeId == null) return
    setSaving(true)
    setSaveError(null)
    const body = reportBody(params, trimmedName)
    const request =
      reportId != null
        ? client.patchTrendReport(activeId, reportId, body)
        : client.createTrendReport(activeId, body)
    request
      .then((saved) => {
        setName(saved.name)
        // CREATE only: this screen becomes that report's own address, the
        // same way a saved segment or funnel is addressed by id. `/trends/
        // new` and `/trends/:id` carry different `key`s in `Router.tsx`, so
        // this is a full remount -- every piece of local state here starts
        // over from the freshly-created report, not from whatever was on
        // screen a moment ago. Carrying the current search across is what
        // keeps the chart that was just built on screen after the remount,
        // rather than resetting it back to the report's bare stored
        // definition. A rename/update (PATCH) needs none of this -- the
        // screen is already at this report's address.
        //
        // I2 from the whole-branch review: `result` (whatever is on screen
        // right now, possibly `null` if nothing was ever run) rides along
        // as router state -- see `JustSavedState`'s own comment for why,
        // and the load effect above for where it is read back. Only ever
        // carries a REAL result: if nothing was run before Save, there is
        // nothing "already on screen" to protect, and the remount's normal
        // fetch-and-maybe-run is the first run, not a repeat of one.
        if (reportId == null) {
          navigate(
            { pathname: trendReportPath(saved.id), search: search.toString() },
            {
              replace: true,
              state: result === null ? undefined : ({ result } satisfies JustSavedState),
            },
          )
        }
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (err instanceof ApiError && err.status === 409) {
          setSaveError('A trend with that name already exists.')
          return
        }
        setSaveError(err instanceof Error ? err.message : 'That trend could not be saved.')
      })
      .finally(() => setSaving(false))
  }, [
    canSave,
    activeId,
    params,
    trimmedName,
    reportId,
    client,
    navigate,
    search,
    result,
    onUnauthorized,
  ])

  // Behind a confirmation, deliberately -- deletion is the one action on
  // this screen with no undo, same reasoning as `FunnelDetail`'s own
  // `handleDelete`. `deleteError` deliberately does NOT reuse `error` (the
  // run banner) or `saveError`: a failed delete leaves everything else on
  // the screen still true, so it gets its own line.
  function handleDelete() {
    if (activeId == null || reportId == null) return
    setDeleting(true)
    setDeleteError(null)
    client
      .deleteTrendReport(activeId, reportId)
      .then(() => navigate(ROUTES.trends))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setDeleteError('Could not delete this trend. Try again.')
      })
      .finally(() => setDeleting(false))
  }

  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <header className="flex flex-col gap-1">
          <h1 className="font-semibold text-xl">Trends</h1>
          <p className="text-muted-foreground text-sm">
            How many of an event over time, and how that splits by a property or a column.
          </p>
        </header>
        <div className="flex items-center gap-3">
          {/* Only for a saved report -- there is nothing to delete at
           * `/trends/new`, same reasoning `FunnelDetail` gates its own Delete
           * on `funnel != null`. */}
          {reportId != null && !confirmingDelete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {reportError != null && (
        <p role="alert" className="text-sm text-destructive">
          {reportError}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="trend-name">Name</Label>
          <Input
            id="trend-name"
            className="w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      {/* A second, explicit click behind the first -- deletion has no undo,
       * so this screen never treats one click on "Delete" as consent. */}
      {confirmingDelete && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-foreground">Delete this trend report? This cannot be undone.</p>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              Delete trend
            </Button>
          </div>
        </div>
      )}

      {deleteError != null && (
        <p role="alert" className="text-sm text-destructive">
          {deleteError}
        </p>
      )}

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
          // NOT `onClick={run}` -- React hands the click's `SyntheticEvent`
          // to whatever `onClick` is, and `run`'s first parameter is now a
          // `TrendParams` with a default rather than nothing, so passing
          // the handler directly would hand that event to `p` and every
          // read of `p.interval`/`p.range` below would throw. The wrapper
          // is what makes this call the zero-argument, default-`params`
          // form -- the same one this button always called.
          onClick={() => run()}
          disabled={running || activeId == null || overCap || incompleteRange || unfinished > 0}
        >
          {running ? 'Running…' : 'Run'}
        </Button>
        <Button type="button" variant="outline" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <WherePredicates
        id="trend-where"
        // `undefined`, never `''`: the combobox reports an empty string when
        // cleared, and `WherePredicates` reads `''` as an event named the
        // empty string rather than as "no scoping".
        event={params.event === '' ? undefined : params.event}
        client={client}
        projectId={activeId ?? 0}
        value={params.where}
        onChange={(next) => update({ where: next ?? [] })}
        onUnauthorized={onUnauthorized}
      />

      {saveError != null && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}

      {params.source === 'property' && (
        <p className="text-muted-foreground text-sm">
          A key from the event's own properties — whatever your app put in <code>properties</code>{' '}
          when it sent the event.
        </p>
      )}

      {stale && (
        <p data-testid="trend-stale" className="text-muted-foreground text-sm">
          The filters saved with this report no longer parse, so it cannot be reproduced as saved.
          Run below to see what these controls ask for now, or fix the conditions and save over it.
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

      {unfinished > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {unfinished === 1 ? '1 filter is' : `${unfinished} filters are`} unfinished — pick a field
          and a value, or remove the row.
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
