import { useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import { ApiError } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'

/**
 * A buffered download, and the reason it is not a link.
 *
 * `packages/server/src/auth/bridge.ts` requires both `x-lyraflow-ui` and
 * `x-lyraflow-project` on the session path, and no `<a download>`, form
 * submission or `window.open()` can set a header. So the bytes come through
 * `fetch` (`ApiClient.personExport`, which reaches it via `callBlob` --
 * see that function's own docstring), which means they are buffered --
 * undoing the streaming `packages/server/src/privacy/export.ts` chose
 * deliberately, because a second copy of one person's complete personal
 * data is exactly the liability that endpoint refuses to create. That
 * trade-off is made here, once, rather than hidden behind a link that looks
 * like an ordinary download.
 *
 * Past `EXPORT_MAX_EVENTS` the button is replaced by the command that
 * streams instead, with the reason stated -- see the ceiling branch below.
 * That is the honest version of this constraint; a button that hangs and
 * then dies is not.
 */

/**
 * Measured against a real export: 20,000 synthetic events (each carrying
 * the same field set the CLI README's own sample line shows -- context
 * fields present but empty, two small property maps) produced a
 * 10,089,087-byte NDJSON body, 504.45 bytes per event line. Real events
 * with populated device/browser/location context will typically run
 * somewhat longer than that, not shorter, so this is a conservative
 * (slightly low) per-event estimate rather than an optimistic one.
 *
 * The plan's starting number, 100,000, buffers to roughly 50 MB at that
 * rate -- the outer edge of "tens of megabytes", not comfortably inside
 * it. Halved to 50,000, the same math puts a buffered export at roughly
 * 25 MB, with real-world headroom given the note above. A person with more
 * events than this is still a small fraction of any real project and is
 * still fully readable -- just through the command below, which streams
 * rather than buffers and so has no ceiling of its own.
 */
export const EXPORT_MAX_EVENTS = 50_000

/**
 * The export action on a person's profile.
 *
 * Under the ceiling: fetch the export as a `Blob`, turn it into an object
 * URL, click a detached anchor to trigger the browser's save dialog, then
 * revoke the URL. The revoke happens in a `finally` -- on success AND on
 * failure, and specifically on a failure that happens AFTER the object URL
 * already exists (the anchor throwing on click or append, say) and not
 * merely on a rejected `personExport` call -- because an unrevoked blob URL
 * holds the whole buffered export alive in memory for the rest of the tab's
 * life, which is the same liability the size ceiling exists to bound,
 * reached by a different route.
 *
 * A 401 here means the session expired between opening the profile and
 * clicking Export -- not that the export itself failed -- so it is reported
 * through `onUnauthorized`, the same signal every other authenticated
 * action on this branch uses, rather than through the generic "could not be
 * exported" message that a retry cannot fix.
 *
 * Over the ceiling: no button at all. A button that starts a request doomed
 * to hang the tab (or that silently truncated the export to stay under the
 * ceiling, understating what the person actually did) is worse than no
 * button -- this volunteers the limit and hands over the one command that
 * has no ceiling, because it streams.
 */
export function ExportButton(props: {
  client: ApiClient
  projectId: number
  personId: string
  eventCount: number
  onUnauthorized?: () => void
}) {
  const { client, projectId, personId, eventCount, onUnauthorized } = props
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(false)

  if (eventCount > EXPORT_MAX_EVENTS) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">
          This person has more than {EXPORT_MAX_EVENTS.toLocaleString('en-US')} events -- past what
          this screen can safely buffer into one download. Their data is still fully readable
          through the API, which streams the export instead of buffering it:
        </p>
        <code className="font-mono">lyraflow persons export {personId}</code>
      </div>
    )
  }

  function handleExport() {
    setExporting(true)
    setError(false)
    let url: string | null = null
    client
      .personExport(projectId, personId)
      .then((blob) => {
        url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        // `.ndjson`, not `.json`: the body is newline-delimited JSON, one
        // object per line, not one JSON document -- a `.json` extension
        // would tell every tool that opens it to expect the latter.
        anchor.download = `${personId}.ndjson`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
      .finally(() => {
        // Revoked here, not only on the success path -- a request that
        // resolved with a blob but then failed to click/append (or one that
        // never got this far at all) must not leak a live object URL
        // either. `url` stays `null` on the reject-before-blob path, and
        // `URL.revokeObjectURL(null)` is intentionally never reached.
        if (url != null) URL.revokeObjectURL(url)
        setExporting(false)
      })
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
        {exporting ? 'Exporting…' : 'Export'}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          This person&apos;s data could not be exported. Try again.
        </p>
      )}
    </div>
  )
}
