import { useEffect, useRef, useState } from 'react'
import { type ApiClient, ApiError } from '../api/client.js'
// The wire shape shares this component's name, so it is imported under
// another one rather than either being renamed: `SharedDashboard` is the
// right name for both the screen and the body it draws.
import type { SharedDashboard as SharedDashboardWire } from '../api/types.js'
import { Mark } from '../app/Shell.js'
import { Button } from '../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js'
import { createRunQueue } from './dashboards/runQueue.js'
import { SharedTile } from './shared-view/SharedTile.js'
import { useSharedRange } from './shared-view/useSharedRange.js'
import { RangePicker } from './shared/RangePicker.js'
import { AUTO } from './shared/range.js'

/**
 * The four things this page can be showing, as one value rather than a set
 * of booleans that could disagree -- the same shape `App`'s `Phase` uses,
 * for the same reason.
 *
 * `gone` and `unavailable` are deliberately separate. A 404 is the one
 * outcome that is not a fault: the link is spent, and there is nothing to
 * retry. Anything else means the server could not be reached or could not
 * answer, which is temporary and IS worth a Try again. Collapsing the two
 * would either offer a button that can only ever fail again, or tell
 * somebody their link is dead during a deploy.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; dash: SharedDashboardWire }

/** A full-page card, the shape `App` uses for its own boot-time failures.
 *  Centred and alone on the page because there is nothing else on a shared
 *  page to put it beside -- no shell, no navigation, no second thing to
 *  read. */
function FullPageCard(props: {
  title: string
  message: string
  onRetry?(): void
}) {
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{props.title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-muted-foreground text-sm">
          <p role="alert">{props.message}</p>
          {props.onRetry && (
            <Button type="button" className="w-full" onClick={props.onRetry}>
              Try again
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * The whole shared viewer surface: a dashboard's name, a range control and
 * its tiles, for somebody holding a share link and nothing else.
 *
 * What is NOT here is as deliberate as what is. No shell, so no navigation
 * to screens this viewer cannot open and no project switcher; no project
 * name anywhere, because `SharedDashboard` (the wire type) carries none and
 * the install a link came from is not the viewer's business; and no link on
 * any tile, because every report screen is behind the login they do not
 * have. The one link on the page is the footer's, which says where this
 * came from.
 */
export function SharedDashboard(props: { client: ApiClient; token: string }) {
  const { client, token } = props
  const [range, setRange] = useSharedRange()
  // One queue for the whole page, held across renders: the cap is on
  // CONCURRENT runs, so a queue rebuilt per render would cap nothing.
  const queue = useRef(createRunQueue()).current
  const [state, setState] = useState<State>({ kind: 'loading' })
  // Bumped by Try again to re-run the load effect, which otherwise depends
  // only on values that never change identity.
  const [reload, setReload] = useState(0)

  // Rewrites the URL once, on mount, so that a pasted `?range=custom&from=…`
  // address -- which is exactly what an operator gets by copying their own
  // dashboard's -- does not sit in the address bar describing a range this
  // page cannot run. `useSharedRange` has already normalised the VALUE; this
  // is what makes the URL agree with it.
  //
  // It does NOT matter that this effect is declared before the load effect
  // below, and the reason is worth stating because the opposite is the
  // natural guess: `setRange` here hands back a NEW object every time, so a
  // rewrite landing after tiles had mounted would change `range`'s identity
  // and re-issue every tile's run. It cannot, in either order. Both effects
  // fire in one passive flush, before any paint; tiles exist only in the
  // `ready` state, which the load below cannot reach until its promise
  // resolves, which is strictly later than both. MEASURED, not reasoned:
  // with the two effects swapped, a two-tile fixture opened on a
  // `?range=custom` URL still issues exactly two runs.
  //
  // **This effect must stay declared BEFORE the load effect below.** Effects
  // fire in declaration order, and `setRange` here is a state update: run
  // second, it lands after the load has already resolved and the tiles have
  // mounted against the pre-rewrite range, so every tile unmounts its run
  // and issues a second one -- two sends per tile on first paint, against a
  // token allowed 120 a minute. Run first, the update is batched into the
  // same commit as the load's `loading` state and no tile has mounted yet.
  // The swap is invisible in a diff and in every assertion that only counts
  // final state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only, on purpose -- listing `range`/`setRange` would rewrite the URL after every range change, which the picker's own `setRange` already did, and listing `range` alone would loop.
  useEffect(() => {
    setRange(range)
  }, [])

  // `reload` is deliberately unread inside the body: it exists only to
  // re-fire this effect, since `client` and `token` never change identity
  // for the life of the page. Removing it makes Try again inert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    client
      .sharedDashboard(token)
      .then((d) => {
        if (!cancelled) setState({ kind: 'ready', dash: d })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // A 404 here is `share_not_found`: the link was unshared, or the
        // dashboard behind it was deleted. Both are permanent from the
        // viewer's side.
        setState(
          err instanceof ApiError && err.status === 404
            ? { kind: 'gone' }
            : { kind: 'unavailable' },
        )
      })
    return () => {
      cancelled = true
    }
  }, [client, token, reload])

  if (state.kind === 'loading') {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  if (state.kind === 'gone') {
    return (
      <FullPageCard
        title="This link is no longer valid."
        message="The dashboard it opened has been unshared or deleted."
      />
    )
  }

  if (state.kind === 'unavailable') {
    // Word for word what `App`'s own `Unavailable` says, because it is the
    // same condition seen from a page with no session -- a viewer who is
    // told something different from an operator looking at the same outage
    // has learned something untrue about it.
    return (
      <FullPageCard
        title="Lyraflow is not responding"
        message="The server did not respond. It may be restarting or temporarily unavailable."
        onRetry={() => setReload((n) => n + 1)}
      />
    )
  }

  const { dash } = state

  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4">
      <h1 className="font-semibold text-2xl tracking-tight">{dash.name}</h1>

      <div className="flex flex-wrap items-end gap-3">
        {/* `presetsOnly`: `SHARED_RANGE_PRESETS` is the entire vocabulary
         * the public run route accepts, so offering `Between two dates…`
         * here would be offering a choice the server answers with a 400. */}
        <RangePicker id="shared-range" value={range} onChange={setRange} presetsOnly />
      </div>

      {/* The same note the operator's own dashboard shows under `auto`, for
       * the same reason: `auto` sends no bounds, so each tile takes its own
       * endpoint's default window and the tiles are showing different
       * periods side by side. The picker's label reads as one shared
       * setting, so saying so is the fix. */}
      {range.preset === AUTO && (
        <p className="text-muted-foreground text-sm">
          At this setting each tile uses its own report's default window. Pick a preset to give
          every tile the same range.
        </p>
      )}

      {dash.stale && (
        <p role="alert" className="text-destructive text-sm">
          {/* No "Add tiles to replace it, or delete it." -- the operator's
           * version of this line ends that way, and neither remedy is
           * something a viewer can do. */}
          This dashboard's stored layout cannot be read by this version.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {dash.tiles.map((tile, i) => (
          // The index is part of the key because it is also the tile's
          // ADDRESS on the run route -- two tiles can name the same report,
          // and a key that could not tell them apart would remount the wrong
          // fetcher when the layout changes.
          <SharedTile
            key={`${i}-${tile.kind}-${tile.report_id}`}
            client={client}
            token={token}
            index={i}
            tile={tile}
            range={range}
            queue={queue}
          />
        ))}
      </div>

      {/* Not shown beside the stale warning: that already explains the blank
       * page, and a second explanation for it would contradict the first. */}
      {dash.tiles.length === 0 && !dash.stale && (
        <p className="text-muted-foreground text-sm">This dashboard has no tiles yet.</p>
      )}

      {/* The mark and where this came from, and nothing else. A viewer is
       * told what they are looking at and who made it; they are not sold
       * anything, and they are not told which install it is. */}
      <footer className="flex items-center gap-2 pt-6 text-muted-foreground text-sm">
        <Mark />
        <span>
          Shared from{' '}
          <a href="https://lyraflow.app" className="underline">
            Lyraflow
          </a>
        </span>
      </footer>
    </main>
  )
}
