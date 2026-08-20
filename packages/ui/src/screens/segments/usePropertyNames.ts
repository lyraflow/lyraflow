import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'

/** How long to wait after the last keystroke before asking the server. */
export const DEBOUNCE_MS = 250

/**
 * The debounced `GET /v1/schema/properties` lookup behind every field that
 * offers property names.
 *
 * Extracted from `PropertyCombobox` when `FieldCombobox` needed the same
 * lookup under a different popup: two copies of a debounce, a 401 route and
 * a three-state "asked / answered / failed" flag is exactly the pair that
 * drifts, and the half that drifts is always the error handling, because
 * nothing on the happy path notices.
 *
 * ## The three states are not two
 *
 * `loading` is "no lookup has answered yet", which is NOT the same as an
 * answer of nothing: without the distinction an empty-list message renders
 * during the first debounce and tells the operator no properties exist
 * before anything has been asked. And a failed lookup deliberately does not
 * become "answered": a request that errored is no evidence about whether
 * names exist, so `error` says the suggestions failed rather than stacking
 * "could not load" with "none recorded yet".
 */
export function usePropertyNames(opts: {
  client: ApiClient
  projectId: number
  /** Scopes suggestions to one event's own properties. `undefined` means
   * "across every event" -- an unchosen or wildcard event. */
  event: string | undefined
  /** The text currently in the field. Trimmed here; the debounce is here too. */
  query: string
  onUnauthorized?: () => void
}): { options: string[]; loading: boolean; error: boolean } {
  const { client, projectId, event, query, onUnauthorized } = opts
  const [options, setOptions] = useState<string[]>([])
  const [fetched, setFetched] = useState(false)
  const [loadError, setLoadError] = useState(false)

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

  useEffect(() => {
    const q = query.trim()
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
          // Deliberately NOT `setFetched(true)`: see this hook's own doc.
        })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // `event` is a real dependency, not an oversight: switching the chosen
    // event must re-scope the very next lookup, not keep serving
    // suggestions for whichever event was selected when this field first
    // fetched.
  }, [query, event, client, projectId])

  return { options, loading: !fetched && !loadError, error: loadError }
}
