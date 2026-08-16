import { useEffect, useId, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

/** How long to wait after the last keystroke before asking the server. */
const DEBOUNCE_MS = 250

/**
 * An event-name field backed by `GET /v1/schema/events`, via a `<datalist>`
 * rather than a closed picker -- a free-typed value the schema has never
 * seen is always accepted, because a funnel written before its own event
 * first fires is legitimate (Task 5 brief).
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
  disabled?: boolean
  onUnauthorized?: () => void
}) {
  const { client, projectId, value, onChange, label, disabled, onUnauthorized } = props
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
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
  const listId = `${id}-events`

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
        .schemaEvents(projectId, q)
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
  }, [text, client, projectId, onUnauthorized])

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        list={listId}
        value={text}
        disabled={disabled}
        autoComplete="off"
        placeholder="Event name -- starts with what you type"
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          onChange(next)
        }}
      />
      {/*
       * No style override here, deliberately. Every browser's UA stylesheet
       * sets `datalist { display: none }` -- production markup does not
       * bend to make a test selector tidier (see the fix-round note this
       * reverted: an inline style here once existed only to satisfy
       * `getByRole('option', ...)`, and shipped a nonstandard override of a
       * native element's browser-default rendering to every self-hoster
       * for that reason alone). The test queries this list with
       * `{ hidden: true }` instead of asking the markup to change.
       */}
      <datalist id={listId}>
        {options.map((event) => (
          <option key={event} value={event}>
            {event}
          </option>
        ))}
      </datalist>
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          Could not load suggestions. You can still type the event name.
        </p>
      )}
    </div>
  )
}
