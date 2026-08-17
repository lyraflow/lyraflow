import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Combobox } from '../../components/Combobox.js'
import { Label } from '../../components/ui/label.js'

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250

/**
 * A property-name field backed by `GET /v1/schema/properties` -- mirrors
 * `../funnels/EventCombobox.tsx` in every way but the endpoint and the added
 * `event` scope. Free-typed, prefix-matched server-side (typing `amoun` will
 * not find `total_amount_cents`), and a name absent from the schema is
 * always accepted: a predicate written before its property has ever been
 * seen is legitimate, the same reasoning `EventCombobox`'s own doc comment
 * gives for event names.
 *
 * ## Eager, unconditionally
 *
 * The lookup runs with an EMPTY query on mount, and `Combobox` shows the
 * result the moment the field is focused. This field used to carry a
 * `suggestOnEmpty` flag, defaulting to OFF for event properties, and the
 * rationale was that a project's property namespace is large so an
 * unfiltered list "is mostly names that cannot match the event in question".
 * That weighed the wrong cost. List noise is a nuisance; a picker that will
 * not show you anything until you already know the first letters of the
 * answer is not a picker -- it helps only the operator who did not need it,
 * and the operator who did is left guessing at a box that looks broken. The
 * flag is gone and both callers fetch on mount.
 *
 * What that costs is bounded and known: `event_schema` is a purpose-built
 * catalogue with one row per property key, and the request is capped at 50
 * names. That is why eagerness is affordable HERE and is not for the trait
 * VALUE field beside it, whose endpoint scans the project's whole trait
 * partition -- see `TraitValueField`, which keeps fetching on focus for
 * exactly that reason.
 *
 * `event` scopes suggestions to one event's own properties: a behaviour's,
 * or a funnel step's, `where` predicates constrain THAT event, so scoping is
 * what makes the list relevant rather than merely large. Pass `undefined`
 * for "suggest across every event" (an unchosen or wildcard `*` event) --
 * the caller decides that, not this component; it forwards whatever it is
 * given straight to `client.schemaProperties`.
 *
 * Nothing here reads a `Behavior` or any segment-specific type -- `client`,
 * `projectId`, an event NAME (not a node), and a plain string value. That is
 * what keeps it equally usable from a funnel-step predicate editor, not just
 * `WherePredicates`.
 */
export function PropertyCombobox(props: {
  client: ApiClient
  projectId: number
  event: string | undefined
  value: string
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  onUnauthorized?: () => void
  /** One line under the field saying where these names come from. Omitted
   * by default: a `where` predicate sits inside a behaviour that already
   * names its event, so the source is on screen. A field whose source is
   * NOT on screen should pass one. */
  hint?: string
  /** Overrides the placeholder for a field that is not literally a
   * "property" to the operator reading it. */
  placeholder?: string
  /** Shown INSIDE the popup when a lookup succeeded and returned nothing,
   * and the box is empty. Say why it is empty -- "none recorded yet" is
   * actionable, an empty dropdown is not. */
  emptyMessage?: string
}) {
  const {
    client,
    projectId,
    event,
    value,
    onChange,
    label,
    disabled,
    onUnauthorized,
    hint,
    placeholder,
    emptyMessage,
  } = props
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
  // Distinguishes "no lookup has answered yet" from "a lookup answered with
  // nothing" -- without it, `emptyMessage` renders during the first debounce
  // and tells the operator no traits exist before anything has been asked.
  const [fetched, setFetched] = useState(false)
  // `onUnauthorized` is a callback a parent typically re-creates on every one
  // of ITS renders, so naming it in the lookup effect's dependency list makes
  // an unrelated parent render re-run the lookup -- a redundant request per
  // keystroke elsewhere on the page. Held in a ref instead, and read only
  // inside the async continuation below.
  //
  // A plain `useEffect` is right here, unlike the identity ref in
  // `SegmentBuilder` which must be written in `useLayoutEffect`: nothing
  // reads this one to make a decision DURING render, only after an await, so
  // there is no window in which a stale value changes what the component
  // renders or refuses.
  const unauthorizedRef = useRef(onUnauthorized)
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized
  }, [onUnauthorized])
  // Same reasoning as EventCombobox's own `loadError`: a 401 routes to
  // `onUnauthorized`, any other failure says the suggestions themselves
  // failed rather than silently implying the property has none -- free
  // typing stays usable either way.
  const [loadError, setLoadError] = useState(false)
  const id = useId()

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    const q = text.trim()
    const timer = window.setTimeout(() => {
      client
        .schemaProperties(projectId, event, q)
        .then((list) => {
          setOptions(list)
          setLoadError(false)
          setFetched(true)
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            unauthorizedRef.current?.()
            return
          }
          setOptions([])
          setLoadError(true)
          // Deliberately NOT `setFetched(true)`: a failed lookup is not an
          // answer about whether any names exist, and `loadError` already
          // says the suggestions themselves failed. Setting it here would
          // stack "could not load" with "none recorded yet", the second of
          // which this call gives no evidence for.
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // `event` is a real dependency, not an oversight: switching the chosen
    // event must re-scope the very next lookup, not keep serving
    // suggestions for whichever event was selected when this field first
    // fetched.
  }, [text, event, client, projectId])

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        label={label}
        value={text}
        options={options}
        loading={!fetched && !loadError}
        emptyMessage={emptyMessage}
        errorMessage={
          loadError
            ? 'Could not load suggestions. You can still type the property name.'
            : undefined
        }
        disabled={disabled}
        placeholder={placeholder ?? 'Property name -- starts with what you type'}
        onChange={(next) => {
          setText(next)
          onChange(next)
        }}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
