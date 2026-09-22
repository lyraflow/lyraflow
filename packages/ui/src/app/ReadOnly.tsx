import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ApiClient } from '../api/client.js'
import { useVersion } from './useVersion.js'

/**
 * Whether this install refuses writes (`LYRAFLOW_READ_ONLY`), for the
 * screens that hide their create, edit and delete controls when it does.
 *
 * Hiding is a courtesy, not the guard: the server refuses the write either
 * way (403 `read_only_install`). So when the answer is unknown -- still
 * loading, or the read failed -- this says "writable". A wrong guess that way
 * costs a visitor a refusal with its own message; a wrong guess the other way
 * would hide every control on an ordinary install whenever one request
 * failed.
 *
 * `false` with no provider, so a screen rendered on its own in a test is the
 * ordinary writable screen it has always been.
 */
const ReadOnlyContext = createContext(false)

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext)
}

/**
 * Reads `/v1/meta` once and provides its `read_only` to everything below.
 * No `onUnauthorized`, for the reason `Shell` gives for its own version
 * read: this is not a screen, and making it a trigger for "sign out" would
 * widen what a failed read can do mid-task.
 */
export function ReadOnlyProvider(props: { client: ApiClient; children?: ReactNode }) {
  const { readOnly } = useVersion(props.client)
  return <ReadOnlyContext.Provider value={readOnly}>{props.children}</ReadOnlyContext.Provider>
}

/** For tests: a fixed answer, without a client. */
export function ReadOnlyValue(props: { value: boolean; children?: ReactNode }) {
  return <ReadOnlyContext.Provider value={props.value}>{props.children}</ReadOnlyContext.Provider>
}
