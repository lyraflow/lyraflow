import { useEffect, useId, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { Segment } from '../../api/types.js'
import { Label } from '../../components/ui/label.js'

/**
 * The funnel's audience filter. Fetches the project's segments once and
 * renders "Everyone" (sends `segment_id: null`, the default population)
 * plus each segment -- `disabled` and labelled with why when `stale`, which
 * is a segment whose stored tree no longer parses. Offering it as a normal,
 * selectable choice would let an operator pick a filter the server can no
 * longer honour; `FunnelDetail` already shows what that failure looks like
 * after the fact (a `segment_id` warning on the run), and this is the one
 * place that failure can be prevented before it happens.
 *
 * A plain native `<select>`, not the Radix combobox used elsewhere -- same
 * reasoning as `RangePicker`: it's what lets `@testing-library/user-event`
 * and `getByRole('option', ...)` drive and inspect it directly, and a
 * native `disabled` option needs nothing extra to be inert.
 */
export function SegmentPicker(props: {
  client: ApiClient
  projectId: number
  value: number | null
  onChange: (value: number | null) => void
  onUnauthorized?: () => void
}) {
  const { client, projectId, value, onChange, onUnauthorized } = props
  const [segments, setSegments] = useState<Segment[]>([])
  // I5 (whole-branch review): before the fetch resolves we don't yet know
  // whether `value` is genuinely missing from the list -- gates
  // `selectedMissing` below so a value isn't read as unresolvable for the
  // one render before the real list arrives.
  const [loaded, setLoaded] = useState(false)
  // I6 (whole-branch review): every error used to be swallowed into an
  // empty list, INCLUDING 401 -- an expired session showed "Everyone" and
  // nothing else, teaching the operator their segments do not exist, the
  // exact failure spec decision 6 exists to prevent for the event
  // autocomplete. A 401 now routes to `onUnauthorized`; any other failure
  // still resolves the picker (Everyone must stay usable) but says so.
  const [loadError, setLoadError] = useState(false)
  const id = useId()

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setLoadError(false)
    client
      .segments(projectId)
      .then((list) => {
        if (cancelled) return
        setSegments(list)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSegments([])
        setLoaded(true)
        setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId, onUnauthorized])

  // I5 (whole-branch review): `segment_id` has NO foreign key, deliberately
  // (`packages/db/migrations/postgres/012_funnels.sql`) -- a `segment_id`
  // absent from `GET /v1/segments` is a DESIGNED state (deleted elsewhere),
  // not an edge case, and distinct from `stale` (listed but broken). Without
  // this, a native `<select>` silently displays "Everyone" for a `value`
  // that matches no `<option>` -- the builder then claims the funnel is
  // unfiltered when it is not, saving silently re-sends the broken filter
  // (state still holds the id), and an operator can't clear it because
  // re-picking "Everyone" fires no change event when it already LOOKS
  // selected.
  const selectedMissing = loaded && value != null && !segments.some((s) => s.id === value)

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Segment</Label>
      <select
        id={id}
        value={selectedMissing ? 'missing' : value == null ? '' : String(value)}
        onChange={(e) => {
          const next = e.target.value
          // The "missing" option is a statement, not a real choice --
          // re-selecting it (a no-op) must not report a change.
          if (next === 'missing') return
          onChange(next === '' ? null : Number(next))
        }}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        <option value="">Everyone</option>
        {/* Rendered ONLY while genuinely unresolvable, and SELECTED -- this
         * is the explicit, honest option I5 requires: it names the state
         * (cannot be resolved) rather than silently defaulting to Everyone,
         * and picking any other option (including Everyone) fires a real
         * change, letting the operator deliberately clear it. */}
        {selectedMissing && (
          <option value="missing">
            Segment #{value} -- cannot be resolved (deleted, or unreadable)
          </option>
        )}
        {segments.map((s) => (
          <option key={s.id} value={s.id} disabled={s.stale}>
            {s.name}
            {s.stale ? ' -- cannot be read' : ''}
          </option>
        ))}
      </select>
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          Could not load segments. Everyone is available; reload to try again for the rest.
        </p>
      )}
    </div>
  )
}
