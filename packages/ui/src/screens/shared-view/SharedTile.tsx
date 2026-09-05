import { useEffect, useState } from 'react'
import { type ApiClient, ApiError } from '../../api/client.js'
import type { ResolvedTile, SharedRangePreset, SharedRunResult } from '../../api/types.js'
import { KIND_LABEL, TileCard, type TileResult, type TileStatus } from '../dashboards/TileCard.js'
import type { RunQueue } from '../dashboards/runQueue.js'
import { ceilingFor } from '../dashboards/tileRequest.js'
import { describeError } from '../funnels/errors.js'
import type { RangeChoice } from '../shared/range.js'

/**
 * How many times a 429 is waited out before the tile gives up and says so.
 *
 * The public run route allows 120 runs per token per 60 seconds and 3 in
 * flight, so a 429 on a shared page is usually somebody else looking at the
 * same link at the same moment -- a condition that clears in seconds, which
 * is why retrying at all is right. Two is enough to ride out that overlap
 * and few enough that a genuinely saturated token stops asking rather than
 * spending the window that other viewers are queueing for. Beyond this the
 * tile shows a message and a Retry button, which puts the next request
 * where it belongs: behind a person deciding to make it.
 */
export const BUSY_MAX_RETRIES = 2

/** Waited out when a 429 carries no usable `retry-after` (see
 *  `retryAfterOf` in `api/client.ts`, which rejects a missing, zero,
 *  negative or non-numeric header). One second is short enough that a
 *  transient overlap clears within the two retries above. */
const BUSY_FALLBACK_SECONDS = 1

/**
 * One tile's fetch on the shared viewer page: runs the tile through the
 * share token and hands the outcome to `TileCard` for rendering.
 *
 * The counterpart of `DashboardTile`, and deliberately a separate module
 * rather than a flag on it. That one names a project, builds each kind's
 * own request from the stored report and can 401 into a logout; this one
 * has a token, sends nothing but a preset (the SERVER rebuilds the request
 * from the stored report, which is what keeps a viewer from asking a
 * question the dashboard's owner never saved), and has no session to lose.
 * The two effects look alike because the cancellation and queue discipline
 * is the same, not because either could be expressed as the other.
 */
export function SharedTile(props: {
  client: ApiClient
  token: string
  index: number
  tile: ResolvedTile
  range: RangeChoice
  queue: RunQueue
}) {
  const { client, token, index, tile, range, queue } = props
  const [status, setStatus] = useState<TileStatus>({ kind: 'loading' })
  // How many 429s have been waited out, AND the range they were waited out
  // for, as one value.
  //
  // The count alone would need a second effect to zero it when the range
  // changes -- and that effect would land after the run effect had already
  // re-fired for the new range with the old count, issuing two requests for
  // one range change. Pairing the count with its range makes the reset a
  // derivation instead of a state update: a new range simply is not the
  // range this count belongs to, so `retries` reads 0 in the same render
  // that changed it, with no extra effect and no second run.
  const [busy, setBusy] = useState<{ range: RangeChoice; count: number }>({ range, count: 0 })
  const retries = busy.range === range ? busy.count : 0
  // The Retry button, and the one dependency the effect never reads -- see
  // `DashboardTile`'s note on the same mechanism.
  const [attempt, setAttempt] = useState(0)

  const deleted = tile.report === null
  const stale = tile.report?.stale === true
  const ceiling = ceilingFor(tile, range, new Date())
  const shouldRun = !deleted && !stale && ceiling === null

  // `tile` and `range` are listed by IDENTITY rather than as a serialised
  // key, matching `DashboardTile`: `SharedDashboard` holds both across
  // re-renders, so a render that changes neither does not re-issue the run.
  //
  // `attempt` is Retry and is deliberately unread inside the body; removing
  // it from the list makes the button inert with no test-visible error.
  // `retries` IS read (to decide whether another wait is allowed), and is
  // also what makes the busy timer fire the next attempt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!shouldRun) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Only reset to `loading` on a FIRST attempt. A retry after a 429 keeps
    // the busy message on screen: dropping back to a skeleton between waits
    // would read as a fresh load and hide the fact that the page is waiting
    // its turn.
    if (retries === 0) setStatus({ kind: 'loading' })

    queue
      // `range.preset` is a `SharedRangePreset` because `useSharedRange`
      // normalises `custom` away before this ever sees it -- that
      // normalisation is the only thing standing between a pasted
      // `?range=custom` URL and a 400 from the run route.
      .run(() => client.runSharedTile(token, index, range.preset as SharedRangePreset))
      .then((r) => {
        if (cancelled) return
        setStatus({ kind: 'result', result: asTileResult(r) })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 429 && retries < BUSY_MAX_RETRIES) {
          setStatus({ kind: 'busy', message: 'Busy, retrying…' })
          timer = setTimeout(
            // The range is captured here rather than read later, so a wait
            // that outlives the range it started under counts against that
            // range and not the new one.
            () => setBusy({ range, count: retries + 1 }),
            (err.retryAfterSeconds ?? BUSY_FALLBACK_SECONDS) * 1000,
          )
          return
        }
        setStatus({
          kind: 'error',
          message:
            err instanceof ApiError && err.status === 429
              ? // NOT `describeError`: it has no 429 branch, so this would
                // read "Something went wrong. Reload to try again." -- and a
                // reload is exactly the wrong advice for a limit that clears
                // on its own.
                'This dashboard is busy. Try again in a moment.'
              : // The tile's OWN noun, for the same reason `DashboardTile`
                // passes one: unqualified, a trend tile reports "This funnel
                // no longer exists."
                describeError(err, KIND_LABEL[tile.kind]),
        })
      })

    return () => {
      cancelled = true
      // Without this a tile unmounted (or re-ranged) mid-wait still fires
      // its retry, which reaches a `setBusy` on a dead component and, on a
      // range change, spends a run on the range nobody is looking at.
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, token, index, queue, tile, range, retries, attempt, shouldRun])

  return (
    <TileCard
      tile={tile}
      range={range}
      status={status}
      // Every report screen is behind the login this viewer does not have,
      // so there is nowhere for a tile to lead. `null` is `TileCard`'s whole
      // switch for that: no title link, no "Open it" in the stale state, and
      // no click on the body.
      href={null}
      editing={false}
      onRetry={() => {
        setBusy({ range, count: 0 })
        setAttempt((n) => n + 1)
      }}
    />
  )
}

/**
 * `SharedRunResult` as the card's `TileResult`.
 *
 * A `switch` rather than a spread with a mapped `kind`: the trend member is
 * `{ result: StatsPage }` on the wire and `{ page: StatsPage }` on the card
 * -- the same page under two names -- and the other two members carry
 * different result types from each other, so only a per-kind branch narrows
 * to the union the card accepts.
 */
function asTileResult(r: SharedRunResult): TileResult {
  switch (r.kind) {
    case 'trend':
      return { kind: 'trend', page: r.result }
    case 'retention':
      return { kind: 'retention', result: r.result }
    case 'funnel':
      return { kind: 'funnel', result: r.result }
  }
}
