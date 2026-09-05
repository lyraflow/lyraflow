import { useEffect, useRef, useState } from 'react'
import type { DashboardShare } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { formatDate } from '../shared/format.js'

/**
 * Builds the URL a share link's viewer opens. The server never guesses its
 * own public origin -- a self-hosted install can sit behind any hostname or
 * path an operator chose -- so the browser is what mints this, from
 * `window.location.origin`, the one value that is always correct for
 * whichever origin actually served this page. `Dashboard.tsx` is the only
 * caller and always passes that.
 */
export function shareUrl(origin: string, token: string): string {
  return `${origin}/shared/${token}`
}

/** How long the Copy button's confirmation label stays up before reverting
 *  to its resting state -- long enough to read, short enough that copying
 *  again a moment later never shows a stale confirmation. */
const CONFIRM_MS = 2000

/**
 * The operator's share panel for one dashboard. `Dashboard.tsx` owns the
 * `DashboardShare` state and the two requests that change it (create,
 * revoke) -- everything here is presentational, driven entirely by props,
 * so the request/response race guards (the `asking` check, the 401 routing)
 * live in exactly one place rather than being duplicated against a second
 * copy of the same state.
 *
 * Before a link exists this states what sharing exposes, so "Create link"
 * is an informed choice rather than a leap of faith -- a share link carries
 * no session and no password, so what it does NOT expose (anything else
 * about the project: other dashboards, the write key, raw events) is worth
 * saying only implicitly, by naming the four things it DOES.
 */
export function ShareCard(props: {
  share: DashboardShare | null
  busy: boolean
  error: string | null
  origin: string
  onCreate: () => void
  onRevoke: () => void
  onClose: () => void
}) {
  const { share, busy, error, origin, onCreate, onRevoke, onClose } = props
  const [copyLabel, setCopyLabel] = useState<'Copied' | 'Select and copy' | null>(null)
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const revertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Without this a Copy click just before unmount -- the card is closed, or
  // Revoke swaps the panel away -- would fire `setCopyLabel` against a
  // component no longer on screen.
  useEffect(() => () => clearTimeout(revertTimer.current), [])

  async function handleCopy() {
    if (share === null) return
    const url = shareUrl(origin, share.token)
    // The async Clipboard API rejects, or is simply absent, on a non-secure
    // origin -- plain HTTP over a private network is exactly what a
    // self-hoster running without a certificate hits -- so there has to be
    // a way to copy the link that does not depend on it existing at all.
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url)
      setCopyLabel('Copied')
    } else {
      inputRef.current?.select()
      setCopyLabel('Select and copy')
    }
    clearTimeout(revertTimer.current)
    revertTimer.current = setTimeout(() => setCopyLabel(null), CONFIRM_MS)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Share this dashboard</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {share === null ? (
          <>
            <p className="text-sm text-muted-foreground">
              A link lets anyone who has it view this dashboard without signing in -- no session, no
              password. It shows:
            </p>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              <li>the dashboard and report names</li>
              <li>event names</li>
              <li>every breakdown value a trend is split by</li>
              <li>every filter value</li>
            </ul>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                readOnly
                aria-label="Share link"
                value={shareUrl(origin, share.token)}
                ref={inputRef}
                className="max-w-md"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={busy}
              >
                Copy
              </Button>
              {copyLabel != null && <output className="text-sm text-success">{copyLabel}</output>}
            </div>
            <p className="text-sm text-muted-foreground">
              Shared since {formatDate(share.shared_at)}
            </p>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          {share === null ? (
            <Button type="button" size="sm" onClick={onCreate} disabled={busy}>
              Create link
            </Button>
          ) : (
            !confirmingRevoke && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingRevoke(true)}
                disabled={busy}
              >
                Revoke link
              </Button>
            )
          )}
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {share !== null && confirmingRevoke && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="text-foreground">
              This link stops working on the next request, and every bookmark of it breaks.
            </p>
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingRevoke(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onRevoke}
                disabled={busy}
              >
                Revoke
              </Button>
            </div>
          </div>
        )}

        {error != null && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
