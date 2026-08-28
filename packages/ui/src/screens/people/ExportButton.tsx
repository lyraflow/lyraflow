import { useEffect, useRef, useState } from 'react'
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
 * **This constant bounds an event COUNT. The thing that hurts a browser is
 * BYTES, and nothing bounds those.** Read the rest of this comment before
 * treating the number as a size guarantee, because an earlier version of it
 * did exactly that and was wrong by two orders of magnitude.
 *
 * What was actually measured, twice:
 *
 * - **The typical line.** 20,000 synthetic events, each carrying the field
 *   set the CLI README's own sample line shows (context fields present but
 *   empty, two small property maps), produced a 10,089,087-byte NDJSON
 *   body: 504.45 bytes per event line. At 50,000 events that is roughly
 *   25 MB, which is where this ceiling comes from.
 * - **The worst line seen.** One `track` event carrying 20 properties of
 *   8 KB each, sent through the ordinary public write key and accepted,
 *   exported at 164,744 bytes -- 327x the figure above. `propertyBag`
 *   (`packages/core/src/ingest/payloads.ts`) is `z.record(z.union([...]))`
 *   with `.max()` on the KEY COUNT only; a property VALUE has no length
 *   cap at any layer of ingest, so that event is not an abuse of the API,
 *   it is inside every documented limit. 50,000 events of that shape
 *   buffer to roughly **7.7 GB**, which no browser tab survives.
 *
 * So the estimate above is not conservative. It is a claim about the
 * TYPICAL event, and the distribution it sits in has no right-hand edge --
 * which is the property that makes a count-based ceiling the wrong
 * instrument for this and a defensible one only because it is cheap,
 * honest about what it is, and available from a number
 * (`Person.events`) the profile read already returned.
 *
 * What this ceiling therefore does and does not do:
 *
 * - It **does** stop the ordinary large person -- someone with a long,
 *   unremarkable history -- from being handed a download that quietly
 *   costs hundreds of megabytes.
 * - It **does not** stop a person under 50,000 events with very large
 *   property maps from exceeding what the browser will hold. That export
 *   can still fail, and it will fail as a `Blob` allocation dying rather
 *   than as anything this component can catch and explain.
 *
 * Bounding the actual bytes needs the size before the buffer -- a `HEAD`
 * with `content-length`, or a streamed read that aborts past a byte budget
 * -- and neither the endpoint nor this button has that today. It is a
 * design change, not a constant change, and it is tracked rather than
 * smuggled in here.
 *
 * The CLI command below is the escape hatch in every one of these cases,
 * and it is the reason the ceiling can be blunt: it streams rather than
 * buffers, so it has no size limit of its own regardless of what any one
 * event carries.
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

  /**
   * The same `cancelled` guard `People` and `Timeline` already use, in the
   * one shape this component can use it: a ref rather than an effect-scoped
   * local, because the request starts from a CLICK and not from an effect,
   * so the flag has to outlive the render that started it.
   *
   * Without it this was the only async call on the screen that could land
   * after its own component was gone, and landing means SIDE EFFECTS, not a
   * stale `setState`: it appends an anchor to `document.body` and clicks it.
   * Two ways that is reached in ordinary use, both of which unmount this
   * component (it is keyed on `person.person_id`, and the profile drops to
   * its loading branch on any id change):
   *
   * - Export A, then follow a person link to B before the bytes arrive --
   *   the browser saves `A.ndjson` while B's profile is on screen, with no
   *   button anywhere claiming to have done it.
   * - Export, then erase the same person -- the deletion completes, the
   *   profile re-reads and 404s, and the export of the person just erased
   *   downloads onto the operator's disk afterwards. That is the one that
   *   matters: it is a copy of exactly the data the erasure was for.
   *
   * Set to `true` in the effect body, not only at the ref's initialiser, so
   * StrictMode's mount/unmount/remount does not leave a live component
   * permanently marked dead.
   */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

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
        // Before the object URL exists, not after -- a cancelled export
        // must leave nothing to revoke rather than create and revoke one.
        if (!live.current) return
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
        // A session that expired while an export nobody is waiting for was
        // in flight must not bounce whoever is on screen now out to the
        // login form, and a failure nobody can see must not be recorded.
        if (!live.current) return
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
        // Revoked unconditionally, INSIDE the cancellation guard rather than
        // behind it -- `url` is only ever non-null on a path that already
        // passed the guard, and a blob URL that outlived its component is
        // the same leak as one that outlived its click.
        if (url != null) URL.revokeObjectURL(url)
        if (live.current) setExporting(false)
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
