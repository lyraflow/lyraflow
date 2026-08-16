import { useEffect, useId, useState } from 'react'
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
}) {
  const { client, projectId, value, onChange } = props
  const [segments, setSegments] = useState<Segment[]>([])
  const id = useId()

  useEffect(() => {
    let cancelled = false
    client
      .segments(projectId)
      .then((list) => {
        if (!cancelled) setSegments(list)
      })
      .catch(() => {
        if (!cancelled) setSegments([])
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId])

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Segment</Label>
      <select
        id={id}
        value={value == null ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        <option value="">Everyone</option>
        {segments.map((s) => (
          <option key={s.id} value={s.id} disabled={s.stale}>
            {s.name}
            {s.stale ? ' -- cannot be read' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
