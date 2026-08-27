import { useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { FunnelPeopleQuery } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { MemberList } from '../segments/MemberList.js'
import { formatCount } from './format.js'

/** Exactly `FunnelPeopleQuery.mode`. Which two of the three a given step
 * offers is decided per step by `optionsFor`, never here. */
type Mode = FunnelPeopleQuery['mode']

/**
 * The two populations a step can be asked about, and what to call them.
 *
 * PER STEP, not a module constant, and that is the whole shape of this
 * change. The server refuses `dropped` on an optional step and `skipped` on
 * a required one, both with a 400 -- so a toggle offering all three, or one
 * offering the wrong two, is not a cosmetic mistake. It is a request that
 * cannot succeed.
 *
 * A required step keeps `Reached` / `Dropped here` verbatim. An optional
 * step's two populations are not "reached" and "dropped" in any sense a
 * reader would recognise: nobody drops out at a branch, they simply did or
 * did not take it, and both halves carry on down the funnel. So the labels
 * say that, in the event's own words -- `Did video_submitted` / `Did not` --
 * rather than reusing a vocabulary that would describe the wrong thing
 * fluently.
 */
function optionsFor(optional: boolean, event: string | undefined): { mode: Mode; label: string }[] {
  if (!optional) {
    return [
      { mode: 'reached', label: 'Reached' },
      { mode: 'dropped', label: 'Dropped here' },
    ]
  }
  return [
    { mode: 'reached', label: event == null ? 'Did this step' : `Did ${event}` },
    { mode: 'skipped', label: 'Did not' },
  ]
}

/**
 * Provisional per-mode counts a caller already has for free -- e.g. derived
 * from the funnel run's own step numbers (`reached(N) = steps[N-1].people`,
 * `dropped(N) = reached(N) - reached(N+1)` over the SPINE, and `skipped(N) =
 * steps[N-1].skipped` on an optional step, all already sitting in
 * `FunnelDetail`'s state) -- shown immediately, with zero requests, before
 * any mode has ever been fetched through this component.
 *
 * These are provisional, not a cache: the moment a real fetch resolves for
 * a mode (see `fetchPage` below), ITS OWN response's `person_count`
 * overrides whatever was seeded here, because a seed can go stale between
 * the run that produced it and the click that opens this panel, and only a
 * fetch shares an `as_of` with the page it labels.
 */
export interface StepPeopleSeedCounts {
  reached?: number
  dropped?: number
  skipped?: number
}

/**
 * The people at one funnel step -- a two-way toggle above a reused
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
 * **Which two modes exist is a property of the STEP.** An optional step
 * offers `reached` and `skipped`; a required one offers `reached` and
 * `dropped`. The server 400s on the other pairing in each direction, so the
 * only mode legal on every step is `reached` -- which is why changing step
 * resets the toggle to it rather than trying to map one mode onto another.
 * `skipped` carried from an optional step onto a required one is a request
 * that cannot succeed, and it would arrive as "could not load these people"
 * with nothing on screen saying why.
 *
 * **Counts are seeded, then self-correct.** `seedCounts` (optional) shows
 * both labels the instant this mounts, at zero request cost -- but a seed is
 * a number computed elsewhere, at another instant, and can be stale by the
 * time an operator actually opens a mode. The moment `MemberList`'s own
 * "Show people" (or Load more, or Retry) actually fetches a mode, THAT
 * response's `person_count` overwrites the seed for that mode -- never the
 * other one, which keeps whatever it last had (seeded or fetched) until it
 * is asked for too. No extra fetch is ever issued purely to keep a count
 * fresh: `MemberList` already gates its walk behind an explicit click, and
 * this component adds no fetch outside that gate, the same "never fetched
 * just because the count was" rule `MemberList`'s own doc comment states for
 * segments.
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
  /** Whether THIS step is optional, as the RUN RESULT reported it -- never
   * as the definition does. It decides which two modes the toggle offers,
   * and the server refuses the other pairing, so it has to come from the
   * same place the numbers did. */
  optional?: boolean
  /** This step's event name, used only to label an optional step's two
   * choices in its own words. Omitted, they fall back to "Did this step". */
  event?: string
  /** See `StepPeopleSeedCounts`. Read once, at mount -- a caller that wants
   * a later change reflected (e.g. a re-run producing new numbers) passes a
   * fresh `StepPeople` instance, keyed the same way `FunnelDetail` already
   * keys the rest of this screen on the question it answers. Re-read once
   * more if `step` or `optional` changes WITHOUT a remount: the counts
   * beside the toggle would otherwise be the previous step's. */
  seedCounts?: StepPeopleSeedCounts
}) {
  const { client, projectId, funnelId, step, range, onUnauthorized, seedCounts } = props
  const optional = props.optional === true
  const options = optionsFor(optional, props.event)
  const [mode, setMode] = useState<Mode>('reached')
  // Per-mode, so switching back to a mode already shown once keeps its
  // count on screen rather than forgetting it because the OTHER mode is
  // now selected. Seeded once, at mount, from `seedCounts`; a real fetch's
  // `.then` below overrides whichever mode it actually answered.
  const [counts, setCounts] = useState<Partial<Record<Mode, number>>>(() => ({
    reached: seedCounts?.reached,
    dropped: seedCounts?.dropped,
    skipped: seedCounts?.skipped,
  }))

  // The question this panel answers, and the only thing the selected mode is
  // valid against. `FunnelDetail` already remounts on a step change, which
  // is what makes this look redundant -- it is not. The invariant is that
  // `mode` is legal for the step currently rendered, and it has to hold for
  // any caller, including one that reuses this instance. `skipped` carried
  // onto a required step is a 400, and `dropped` onto an optional one is
  // another; `reached` is legal on every step, so the reset goes there
  // rather than trying to map one mode onto its nearest neighbour, which
  // would silently change WHICH PEOPLE the reader is looking at.
  const question = `${step}:${optional}`
  const [askedAbout, setAskedAbout] = useState(question)
  if (askedAbout !== question) {
    setAskedAbout(question)
    setMode('reached')
    setCounts({
      reached: seedCounts?.reached,
      dropped: seedCounts?.dropped,
      skipped: seedCounts?.skipped,
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-2">
        {options.map(({ mode: optionMode, label }) => {
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
        // The step is in the key as well as the mode: a cursor is a keyset
        // over ONE population, and step 3's people are not step 2's any more
        // than `dropped`'s are `reached`'s. Remounting is what keeps a
        // caller that reuses this instance across steps from continuing the
        // previous step's walk with the new step's `fetchPage`.
        key={`${question}:${mode}`}
        // The step click, or the toggle, WAS the request -- see
        // `MemberList`'s own `autoLoad` doc. Without this the reader clicks
        // a bar, then clicks "Show people", and does it again on every step
        // and every mode switch, because this list is remounted each time.
        autoLoad
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
              // beside it -- overrides whatever was seeded (or fetched
              // before) for THIS mode only, never the other one, and never
              // a count fetched separately, which could observe a
              // different instant than the page it is printed next to
              // (`MemberList`'s own comment on `person_count`).
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
