import { useEffect, useId, useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import { Combobox } from '../../components/Combobox.js'
import { Label } from '../../components/ui/label.js'
import { usePropertyNames } from './usePropertyNames.js'

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
  const id = useId()

  useEffect(() => {
    setText(value)
  }, [value])

  // The lookup, the debounce and the 401 route live in `usePropertyNames` --
  // shared with `FieldCombobox`, which offers the same names under a
  // sectioned popup. Same reasoning as EventCombobox's own `loadError`: a
  // 401 routes to `onUnauthorized`, any other failure says the suggestions
  // themselves failed rather than silently implying the property has none.
  const { options, loading, error } = usePropertyNames({
    client,
    projectId,
    event,
    query: text,
    onUnauthorized,
  })

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        label={label}
        value={text}
        options={options}
        loading={loading}
        emptyMessage={emptyMessage}
        errorMessage={
          error ? 'Could not load suggestions. You can still type the property name.' : undefined
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
