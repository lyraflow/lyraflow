import { useEffect, useId, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250

/**
 * A property-name field backed by `GET /v1/schema/properties`, via a
 * `<datalist>` rather than a closed picker -- mirrors
 * `../funnels/EventCombobox.tsx` in every way but the endpoint and the added
 * `event` scope. Free-typed, prefix-matched server-side (typing `amoun` will
 * not find `total_amount_cents`), and a name absent from the schema is
 * always accepted: a predicate written before its property has ever been
 * seen is legitimate, the same reasoning `EventCombobox`'s own doc comment
 * gives for event names.
 *
 * `event` scopes suggestions to one event's own properties:
 * a behaviour's, or a funnel step's, `where`
 * predicates constrain THAT event, so suggesting every property in the
 * project is noise -- worse than noise for a project with many event types,
 * since most suggestions cannot match. Pass `undefined` for "suggest across
 * every event" (an unchosen or wildcard `*` event) -- the caller decides
 * that, not this component; it forwards whatever it is given straight to
 * `client.schemaProperties`.
 *
 * Nothing here reads a `Behavior` or any segment-specific type -- `client`,
 * `projectId`, an event NAME (not a node), and a plain string value. That is
 * what keeps it equally usable from a future funnel-step predicate editor,
 * not just `WherePredicates`.
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
  /** Fetch with an EMPTY query too, so the list is populated before the
   * first keystroke.
   *
   * Off by default, and that default is the right one for event
   * properties: a project's property namespace is bounded only by abuse
   * controls, so an unfiltered list is mostly names that cannot match the
   * event in question. It is wrong for a small, closed-in-practice
   * namespace -- person traits, where a project has a handful and the
   * operator's problem is not narrowing the list but knowing that any
   * exist. Opt in per field rather than guessing from cardinality at
   * runtime. */
  suggestOnEmpty?: boolean
  /** Shown when a lookup succeeded and returned nothing. Only reachable
   * with `suggestOnEmpty`, since otherwise an empty list is the normal
   * state before typing rather than an answer. Say why it is empty --
   * "none recorded yet" is actionable, an empty dropdown is not. */
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
    suggestOnEmpty,
    emptyMessage,
  } = props
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
  // Distinguishes "no lookup has answered yet" from "a lookup answered with
  // nothing" -- without it, `emptyMessage` renders during the first debounce
  // and tells the operator no traits exist before anything has been asked.
  const [fetched, setFetched] = useState(false)
  // Same reasoning as EventCombobox's own `loadError`: a 401 routes to
  // `onUnauthorized`, any other failure says the suggestions themselves
  // failed rather than silently implying the property has none -- free
  // typing stays usable either way.
  const [loadError, setLoadError] = useState(false)
  const id = useId()
  const listId = `${id}-properties`

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    const q = text.trim()
    if (q === '' && !suggestOnEmpty) {
      setOptions([])
      setLoadError(false)
      setFetched(false)
      return
    }
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
            onUnauthorized?.()
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
  }, [text, event, client, projectId, onUnauthorized, suggestOnEmpty])

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        list={listId}
        aria-label={label}
        value={text}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder ?? 'Property name -- starts with what you type'}
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          onChange(next)
        }}
      />
      {/* No style override -- see EventCombobox's own doc comment on why a
       * native `datalist` is left at its UA default `display: none`. */}
      <datalist id={listId}>
        {options.map((property) => (
          <option key={property} value={property}>
            {property}
          </option>
        ))}
      </datalist>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {emptyMessage && fetched && options.length === 0 && !loadError && (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      )}
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          Could not load suggestions. You can still type the property name.
        </p>
      )}
    </div>
  )
}
