import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { Combobox } from './Combobox.js'
import { Label } from './ui/label.js'

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250

/**
 * An event-name field backed by `GET /v1/schema/events`.
 *
 * A free-typed value the schema has never seen is always accepted, because a
 * funnel written before its own event first fires is legitimate. The list is
 * a help, never a whitelist.
 *
 * ## Eager, and it opens on focus
 *
 * The lookup runs with an EMPTY query on mount, so the whole catalogue is
 * there before the operator focuses -- and `Combobox` shows it the moment
 * they do. An operator who does not yet know their event names is exactly
 * who this field is for, and a list that appears only after a few correct
 * characters have been guessed helps only the operator who did not need it.
 * `event_schema` is a catalogue with one row per event name, which is what
 * makes asking on render affordable here (the trait VALUE lookup, a
 * partition scan, is deliberately not -- see `TraitValueField`).
 *
 * The server filters with `startsWith(event_name, q)`, not a fuzzy match --
 * typing `signup` will NOT find `user_signup_completed`. The placeholder
 * says so in words, because a control that looks like fuzzy search and
 * silently is not teaches the operator their event does not exist, when
 * the truth is only that it doesn't start with what they typed.
 *
 * Text is owned locally (`text`, seeded from `value` on mount) rather than
 * this being a plain controlled input driven straight off `props.value`.
 * The builder's own state updates asynchronously through `onChange`, and a
 * harness that renders this with a `value` prop that never changes (as this
 * module's own tests, and any caller that doesn't feed the value back every
 * render) would otherwise have every keystroke immediately overwritten by
 * React re-asserting the unchanged prop. Local state is what lets typing
 * behave normally regardless of whether the caller round-trips the value.
 * The `[value]`-keyed effect below still re-seeds from a genuinely new
 * incoming value -- the case that matters is edit mode, where the funnel
 * fetch resolves and this control is already mounted with an empty seed.
 */
export function EventCombobox(props: {
  client: ApiClient
  projectId: number
  value: string
  onChange: (value: string) => void
  label: string
  /**
   * The accessible name, when it must differ from the visible label.
   *
   * A funnel step's card is already headed "Step 1", so the field inside it
   * reads better as plain "Event" -- but N steps then put N controls named
   * "Event" on one page, which is ambiguous to a screen reader and to any
   * test addressing a field by name. This keeps the short visible label and
   * gives the control a unique name.
   */
  accessibleName?: string
  disabled?: boolean
  onUnauthorized?: () => void
}) {
  const { client, projectId, value, onChange, label, accessibleName, disabled, onUnauthorized } =
    props
  const name = accessibleName ?? label
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
  // Separates "no lookup has answered yet" from "a lookup answered with
  // nothing". Without it the popup asserts an absence on the very first
  // frame, before anything has been asked.
  const [fetched, setFetched] = useState(false)
  // I6 (whole-branch review): every schemaEvents failure -- INCLUDING 401 --
  // used to be swallowed into an empty options list, which reads as "your
  // events do not exist" (an expired session, not a real absence). Spec
  // decision 6 exists to prevent exactly that misreading for the prefix
  // filter's empty state; a permanently empty autocomplete for the WRONG
  // reason is the same failure with a different cause. A 401 routes to
  // `onUnauthorized`; any other failure still leaves free-typing usable
  // (this field always accepts an unlisted name) but says the suggestions
  // themselves failed, rather than silently implying there are none.
  const [loadError, setLoadError] = useState(false)
  const id = useId()

  // `onUnauthorized` is re-created inline by most parents on every one of
  // THEIR renders, so naming it in the lookup effect's dependency list makes
  // an unrelated render anywhere above this field issue another request for
  // a query that has not changed. Held in a ref and read only after the
  // await, exactly as `PropertyCombobox` does.
  const unauthorizedRef = useRef(onUnauthorized)
  useEffect(() => {
    unauthorizedRef.current = onUnauthorized
  }, [onUnauthorized])

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    const q = text.trim()
    const timer = window.setTimeout(() => {
      client
        .schemaEvents(projectId, q)
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
          // Deliberately NOT `setFetched(true)`: a failed lookup is no
          // evidence about whether any events exist, and `loadError` already
          // says the suggestions themselves failed.
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, client, projectId])

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        label={name}
        value={text}
        options={options}
        loading={!fetched && !loadError}
        emptyMessage="No events recorded yet -- they appear here once your app sends some."
        errorMessage={
          loadError ? 'Could not load suggestions. You can still type the event name.' : undefined
        }
        disabled={disabled}
        placeholder="Event name -- starts with what you type"
        onChange={(next) => {
          setText(next)
          onChange(next)
        }}
      />
    </div>
  )
}
