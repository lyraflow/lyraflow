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
}) {
  const { client, projectId, event, value, onChange, label, disabled, onUnauthorized } = props
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
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
    if (q === '') {
      setOptions([])
      setLoadError(false)
      return
    }
    const timer = window.setTimeout(() => {
      client
        .schemaProperties(projectId, event, q)
        .then((list) => {
          setOptions(list)
          setLoadError(false)
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          setOptions([])
          setLoadError(true)
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // `event` is a real dependency, not an oversight: switching the chosen
    // event must re-scope the very next lookup, not keep serving
    // suggestions for whichever event was selected when this field first
    // fetched.
  }, [text, event, client, projectId, onUnauthorized])

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
        placeholder="Property name -- starts with what you type"
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
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          Could not load suggestions. You can still type the property name.
        </p>
      )}
    </div>
  )
}
