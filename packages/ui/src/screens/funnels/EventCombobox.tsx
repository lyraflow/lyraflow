import { useEffect, useId, useState } from 'react'
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
}) {
  const { client, projectId, value, onChange, label, disabled } = props
  const [text, setText] = useState(value)
  const [options, setOptions] = useState<string[]>([])
  const id = useId()
  const listId = `${id}-events`

  useEffect(() => {
    setText(value)
  }, [value])

  useEffect(() => {
    const q = text.trim()
    if (q === '') {
      setOptions([])
      return
    }
    const timer = window.setTimeout(() => {
      client
        .schemaEvents(projectId, q)
        .then(setOptions)
        .catch(() => setOptions([]))
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [text, client, projectId])

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
       * Every browser's UA stylesheet sets `datalist { display: none }` --
       * a `<datalist>` is never laid out, so its `<option>` children have no
       * box, and an element with no box is invisible to the accessibility
       * tree regardless of what native-picker UI a browser draws for it.
       * That is correct for a sighted user, but it means an unstyled
       * `<datalist>` is invisible to `getByRole('option', ...)` too, not
       * only to the eye (verified against this exact jsdom against
       * `display: none` directly). The inline style below is the standard
       * visually-hidden technique -- override `display` so the element has
       * a box again, then clip that box to nothing -- so the accessible
       * name of each option is queryable the same way a real screen reader
       * would see it, without the list ever painting on screen.
       */}
      <datalist
        id={listId}
        style={{
          display: 'block',
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
      >
        {options.map((event) => (
          <option key={event} value={event}>
            {event}
          </option>
        ))}
      </datalist>
    </div>
  )
}
