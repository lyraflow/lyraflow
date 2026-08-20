import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { Funnel } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, funnelPath } from '../app/Router.js'
import { Badge } from '../components/ui/badge.js'
import { Button } from '../components/ui/button.js'
import {
  formatPercent,
  formatRangeDays,
  formatRelative,
  formatWindow,
  stepChain,
} from './funnels/format.js'

/**
 * `last_entered`/`last_converted`/`last_evaluated_at` are a CACHE the
 * server writes together after each run and never recomputes on read (see
 * `Funnel`'s own doc comment in `api/types.ts`) -- a funnel that has never
 * been run has `last_evaluated_at === null`, a different fact from a 0%
 * conversion rate, and must never render as one.
 *
 * Two SEPARATE guards, deliberately not merged into one null-check: the
 * first says "this funnel has never been run"; the second says "it was run
 * but nothing entered in that window" (a real, distinct case).
 *
 * I4 (whole-branch review, CRITICAL-class conflation): the second guard
 * used to ALSO read "Not run yet" -- the same no-data/real-zero conflation
 * this branch already fixed in `StepBars`, inverted. A funnel that ran and
 * found nobody must show that it ran, when, and that nobody entered; folding
 * it into "not run yet" loses the timestamp and reads as a funnel nobody has
 * touched, when the truth is it ran and answered "zero".
 *
 * MINOR (whole-branch review): `last_entered` is typed `number | null` --
 * the guard above only caught the LITERAL `0`, so a non-null
 * `last_evaluated_at` paired with a `null` `last_entered` fell through to
 * the division below. `Number(null)` is `0`, so that division is legitimate
 * ONLY once `last_entered` is known to be a real, positive count; for `0` or
 * `null` it is `x / 0`, which is `Infinity` (or `NaN` for `0 / 0`) --
 * `formatPercent` happens to catch both and print "0%", which silently
 * reads as a real, computed rate rather than "the wire carries no rate for
 * this row". Both must short-circuit to the same "0 entered" text as the
 * literal-zero case above, before the division is ever reached.
 */
/**
 * The RANGE the cached counts came from, rendered beside them (#91).
 *
 * Without it this row showed a rate next to a timestamp and nothing else, so a
 * funnel last run over 90 days displayed a 90-day conversion rate under a
 * heading that implies the 7-day default. Two people reading the same row were
 * answering different questions and neither could tell.
 *
 * `'range unknown'` rather than a guess for a row summarised before the server
 * recorded ranges. The numbers are real; what they answer is not known, and
 * labelling them "Last 7 days" because that is the default would manufacture
 * exactly the false precision this fixes.
 */
function rangeLabel(f: Funnel): string {
  return f.last_range === null ? 'range unknown' : formatRangeDays(f.last_range)
}

function funnelRateLabel(f: Funnel, now: Date): string {
  if (f.last_evaluated_at === null) return 'Not run yet'
  if (f.last_entered === 0 || f.last_entered === null) {
    return `0 entered · ${rangeLabel(f)} · ${formatRelative(f.last_evaluated_at, now)}`
  }
  const rate = Number(f.last_converted) / Number(f.last_entered)
  return `${formatPercent(rate)} · ${rangeLabel(f)} · ${formatRelative(f.last_evaluated_at, now)}`
}

/** A stale funnel's `steps` no longer parse -- rendering an empty step chain
 * would read as "a funnel with zero steps" rather than "unreadable".
 *
 * Otherwise `stepChain`, which shows each step's own `where` predicates
 * rather than the bare event name: this row used to render two funnels
 * differing only in their predicates identically, which was tolerable while
 * only the API could write one and is not now that the builder does. The
 * brackets `stepChain` puts round each clause are what keep one step's
 * predicates from reading as the next step's -- see its own doc comment. */
function stepSummary(f: Funnel): string {
  if (f.stale) return 'Steps cannot be read'
  return stepChain(f.steps)
}

/**
 * Defect 2 from the Task 8 visual pass: the binding spec (decision 1) says
 * every row carries name, the step chain, the window, whether a segment
 * filter applies, and the cached rate with its timestamp -- the window and
 * segment indicator were missing entirely. Both matter for the same reason:
 * two funnels over identical steps read as different questions once their
 * windows differ (1 hour vs. 30 days), and a segment-filtered funnel is not
 * measuring the same population as one that isn't -- without both, rows
 * are not comparable to each other. `segment_id` alone is resolved, not the
 * segment's name: `Funnel` carries only the id on the wire, and resolving
 * names to display here is deliberately deferred (see the defect report).
 */
function FunnelRow(props: { funnel: Funnel }) {
  const { funnel } = props
  return (
    <li>
      <Link
        to={funnelPath(funnel.id)}
        className="flex flex-col gap-1 rounded-md border border-border bg-card px-4 py-3 hover:bg-muted"
      >
        <span className="font-medium text-foreground">{funnel.name}</span>
        {/* `break-words`: a step chain now carries operator-typed values,
         * and one long unbroken token (a URL, a UUID) would otherwise push
         * the row wider than the viewport at 390px. */}
        <span className="min-w-0 break-words text-sm text-muted-foreground">
          {stepSummary(funnel)}
        </span>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{formatWindow(funnel.window_seconds)}</span>
          {funnel.segment_id != null && <Badge variant="secondary">Segment filter</Badge>}
        </span>
        <span className="text-sm text-muted-foreground">{funnelRateLabel(funnel, new Date())}</span>
      </Link>
    </li>
  )
}

/**
 * The funnels list -- fetched once per active project, exactly `Settings`'
 * shape (`useEffect` on `[client, activeId]`, a `cancelled` flag, a 401
 * routed to `onUnauthorized`, everything else to a generic error state).
 *
 * Deliberately does NOT call `runFunnel`: the rates shown here are the
 * server's cache as of its last run, not a fresh evaluation, and a list
 * screen silently re-running every funnel on every visit would turn a page
 * load into an unbounded number of ClickHouse scans.
 */
export function Funnels(props: {
  client: ApiClient
  onUnauthorized?: () => void
}) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [funnels, setFunnels] = useState<Funnel[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setFunnels(null)
    setError(false)
    client
      .funnels(activeId)
      .then((list) => {
        if (!cancelled) setFunnels(list)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, onUnauthorized])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Funnels</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.funnelNew}>Create funnel</Link>
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load funnels. Reload to try again.
        </p>
      )}

      {funnels != null && funnels.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No funnels yet. Create one to see conversion between steps.
        </p>
      )}

      {funnels != null && funnels.length > 0 && (
        <ul className="flex flex-col gap-2">
          {funnels.map((f) => (
            <FunnelRow key={f.id} funnel={f} />
          ))}
        </ul>
      )}
    </div>
  )
}
