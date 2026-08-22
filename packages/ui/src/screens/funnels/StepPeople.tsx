import { useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { MemberList } from '../segments/MemberList.js'
import { formatCount } from './format.js'

type Mode = 'reached' | 'dropped'

const OPTIONS: { mode: Mode; label: string }[] = [
  { mode: 'reached', label: 'Reached' },
  { mode: 'dropped', label: 'Dropped here' },
]

/**
 * The people at one funnel step -- a reached/dropped toggle above a reused
 * `MemberList`.
 *
 * **`reached` and `dropped` are different populations, not two views of one
 * list.** `reached` is `level >= step` (everyone who got at least this far)
 * and matches the number on the bar above; `dropped` is `level = step`
 * (everyone who stopped exactly here) and is deliberately a different,
 * smaller number. A list whose length disagrees with the chart above it has
 * to explain itself on screen, which is why each toggle option carries its
 * OWN count once it is known, rather than one count shown once for whichever
 * mode happens to be selected.
 *
 * **Counts are never fetched just because they would be nice to show.**
 * `MemberList` already gates its (potentially expensive) walk behind an
 * explicit "Show people" click, and this component adds no fetch of its own
 * outside that gate: a mode's count is simply read off the `person_count`
 * that already rides along with its first page, the same way `MemberList`'s
 * own doc comment describes for segments. Before a mode has ever been shown,
 * its toggle option carries no count at all -- not zero, not the other
 * mode's number, nothing -- because nothing has been asked yet.
 *
 * **Switching mode restarts the walk.** `MemberList` is keyed on `mode`, so
 * changing it unmounts the previous instance -- cursor, rows, "shown" state,
 * all of it -- rather than continuing an old walk with a new `fetchPage`. A
 * `reached` cursor replayed against `dropped` would page through a keyset
 * computed over a different population, and the server refuses it by cursor
 * label anyway; remounting is what keeps the client from even trying.
 *
 * **`MemberList` is reused UNCHANGED.** This component's only job is to
 * supply it a `fetchPage` closed over the current step/mode/range, and to
 * intercept a 401 the same way every other fetch on this screen does --
 * `MemberList` has no reason to know about `ApiError` or `onUnauthorized`,
 * so the interception happens here, before the rejection reaches it.
 */
export function StepPeople(props: {
  client: ApiClient
  projectId: number
  funnelId: number
  step: number
  range: { since: string; until: string }
  onUnauthorized?: () => void
}) {
  const { client, projectId, funnelId, step, range, onUnauthorized } = props
  const [mode, setMode] = useState<Mode>('reached')
  // Per-mode, so switching back to a mode already shown once keeps its
  // count on screen rather than forgetting it because the OTHER mode is
  // now selected.
  const [counts, setCounts] = useState<Partial<Record<Mode, number>>>({})

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-2">
        {OPTIONS.map(({ mode: optionMode, label }) => {
          const count = counts[optionMode]
          const text = count == null ? label : `${label} (${formatCount(count)})`
          return (
            <Button
              key={optionMode}
              type="button"
              size="sm"
              variant={mode === optionMode ? 'default' : 'outline'}
              aria-pressed={mode === optionMode}
              onClick={() => setMode(optionMode)}
            >
              {text}
            </Button>
          )
        })}
      </div>
      <MemberList
        key={mode}
        fetchPage={(cursor) =>
          client
            .funnelPeople(projectId, funnelId, {
              step,
              mode,
              since: range.since,
              until: range.until,
              cursor,
            })
            .then((page) => {
              // From THIS response, sharing an `as_of` with the members
              // beside it -- never a count fetched separately, which could
              // observe a different instant than the page it is printed
              // next to (`MemberList`'s own comment on `person_count`).
              setCounts((prev) => ({ ...prev, [mode]: page.person_count }))
              return page
            })
            .catch((err: unknown) => {
              // Same 401 routing every other fetch on this screen does --
              // MemberList still sees a rejection (and shows its own
              // generic error/Retry) since it has no reason to know about
              // `ApiError` or `onUnauthorized`, but a session that actually
              // expired navigates away instead of reading as "could not
              // load these people".
              if (err instanceof ApiError && err.status === 401) onUnauthorized?.()
              throw err
            })
        }
      />
    </div>
  )
}
