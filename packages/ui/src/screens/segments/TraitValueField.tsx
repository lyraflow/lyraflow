import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { ConditionValue } from './ValueInput.js'
import { ValueInput } from './ValueInput.js'

/** How long to wait after the last keystroke before asking the server.
 * Same figure as `PropertyCombobox`'s, for the same reason. */
const DEBOUNCE_MS = 250

/** What one lookup answered, and which trait it answered ABOUT. Carrying the
 * trait alongside the result is what makes a stale answer unusable rather
 * than merely unlikely: `plan`'s values must never be offered under
 * `country`, and a plain `string[]` cannot tell the two apart. */
type Answer = { trait: string; options: string[] } | { trait: string; failed: true }

/**
 * The trait condition's VALUE field: a `ValueInput` with a suggestion list
 * behind it, fetched from `GET /v1/schema/trait-values`.
 *
 * ## Why this is not `PropertyCombobox`
 *
 * Both fields render the same `Combobox` -- the same input, the same popup,
 * the same keyboard handling, and both open on focus. What differs is WHEN
 * each one asks the server, and that difference is the whole reason this is
 * a separate component:
 *
 *  - `PropertyCombobox` (the trait NAME field) fetches on mount, because it
 *    reads `event_schema`, a catalogue with one row per property key. This
 *    one must NOT: `person_traits` is ordered by `(project_id,
 *    anonymous_id, user_id, trait_key)`, so a lookup by trait cannot use the
 *    sort key at all and scans the project's whole trait partition. A
 *    segment builder renders one of these per condition row, so fetching on
 *    mount would put N partition scans behind opening a screen nobody has
 *    typed into yet. Nothing is fetched until the operator focuses a value
 *    box -- which is also the moment the popup opens, so the list is there
 *    by the time they could read it;
 *  - it keys off an event name and owns its own `<input>`. This one keys off
 *    a TRAIT name, and cannot own its input at all: `between` needs two
 *    boxes, and the reshaping that keeps `operator` and `value` agreeing
 *    lives in `ValueInput` and must keep living there.
 *
 * Reaching those through flags on the shared field wrapper would have meant
 * a third client method, an eagerness switch and a second scope, none of
 * which the property caller would ever pass -- so the two stay two
 * components over one `Combobox`, and what they genuinely share
 * (`ValueInput`) stays shared.
 *
 * ## Free-typed
 *
 * The suggestions are never a whitelist, exactly as for the trait name: a
 * segment may be written ahead of the data that fills it. Everything here
 * only populates a list; typing anything at all still works, and a failed or
 * empty lookup leaves the field fully usable.
 */
export function TraitValueField(props: {
  client: ApiClient
  projectId: number
  /** The trait whose values these are. Empty means the operator has not
   * chosen one yet -- there is nothing to suggest the values OF, and asking
   * would scan for nothing. */
  trait: string
  operator: string
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  onUnauthorized?: () => void
}) {
  const { client, projectId, trait, operator, value, onChange, onUnauthorized } = props
  // What the operator has asked for, and never anything else: `null` until
  // they touch a box. Every fetch this component makes is downstream of this
  // being non-null, which is what makes "no request on render" a property of
  // the code rather than a timing accident.
  const [ask, setAsk] = useState<{ trait: string; q: string } | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)

  const key = trait.trim()

  // `onUnauthorized` is re-created by every render of `App` -- SegmentBuilder
  // records the same fact about it -- so keeping it in the dependency array
  // below would re-run this effect, and with it a partition scan, on every
  // unrelated parent render once the field has been touched. A ref keeps the
  // latest callback without letting it trigger a lookup. `client` needs no
  // such treatment: App holds it in a lazy `useState` initialiser, so its
  // identity is stable for the session.
  const unauthorizedRef = useRef(onUnauthorized)
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized
  }, [onUnauthorized])

  // Derived, not stored, and that is the point: the moment `trait` changes,
  // the previous trait's answer stops being rendered -- no effect has to run
  // first, so there is no frame in which `country` offers plan's values.
  const current = answer !== null && answer.trait === key ? answer : null
  const options = current !== null && 'options' in current ? current.options : []
  const fetched = current !== null && 'options' in current
  const loadError = current !== null && 'failed' in current

  useEffect(() => {
    // Two refusals, and they are the whole cost story:
    //  - `ask === null`: nothing has been asked for, so nothing is fetched.
    //    This is what "on explicit interaction only" means;
    //  - `ask.trait !== key`: the operator asked about a trait they have
    //    since changed. Re-asking on their behalf would put a partition scan
    //    behind every keystroke in the trait NAME field, which is exactly
    //    the eagerness this endpoint cannot afford. The next interaction
    //    with a value box asks again.
    if (ask === null || ask.trait === '' || ask.trait !== key) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      client
        .schemaTraitValues(projectId, ask.trait, ask.q)
        .then((list) => {
          if (cancelled) return
          setAnswer({ trait: ask.trait, options: list })
        })
        .catch((err: unknown) => {
          if (cancelled) return
          if (err instanceof ApiError && err.status === 401) {
            unauthorizedRef.current?.()
            return
          }
          setAnswer({ trait: ask.trait, failed: true })
        })
    }, DEBOUNCE_MS)
    return () => {
      // Covers both the debounce (a keystroke inside 250ms replaces the
      // pending lookup) and the response (an answer that arrives after the
      // trait changed is dropped rather than written under the new trait --
      // `current` would hide it, but storing it would still be a lie).
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [ask, key, client, projectId])

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-2">
        <ValueInput
          operator={operator}
          value={value}
          onChange={onChange}
          suggest={{
            options,
            // The popup must not assert an absence before anything has been
            // asked: until a lookup answers for THIS trait, it says it is
            // still looking rather than "none recorded".
            loading: !fetched && !loadError,
            emptyMessage: 'No values recorded for this trait yet -- you can still type one.',
            errorMessage: loadError
              ? 'Could not load suggestions. You can still type the value.'
              : undefined,
            onInteract: (text) => setAsk({ trait: key, q: text.trim() }),
          }}
        />
      </div>
    </div>
  )
}
