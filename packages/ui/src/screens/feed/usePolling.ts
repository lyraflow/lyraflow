import { useEffect, useState } from 'react'

export interface PollingState<T> {
  data: T | null
  error: unknown
  loading: boolean
}

/**
 * Runs `fn` immediately, then again every `intervalMs`, never overlapping --
 * the next call is scheduled only after the previous one settles, so a slow
 * request on a fast interval cannot stack calls until the tab is doing
 * nothing but retrying. A rejection is captured (see below) and does not
 * stop the loop.
 *
 * `data` keeps the last successful result across a failing call -- an error
 * populates `error` but never clears `data`, because on a live feed a blank
 * screen after a transient failure reads as "tracking stopped", which is
 * the false alarm this hook exists to prevent.
 *
 * The effect restarts (and calls immediately) whenever `fn`'s identity
 * changes, so a caller that wants a fresh poll the moment its inputs
 * change -- e.g. the active project -- should memoize `fn` with
 * `useCallback` on those inputs rather than waiting out the interval.
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [state, setState] = useState<PollingState<T>>({ data: null, error: null, loading: true })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick() {
      try {
        const data = await fn()
        if (cancelled) return
        setState({ data, error: null, loading: false })
      } catch (error) {
        if (cancelled) return
        // Keep whatever data is already on screen -- only `error` and
        // `loading` change.
        setState((prev) => ({ data: prev.data, error, loading: false }))
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs)
      }
    }

    void tick()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [fn, intervalMs])

  return state
}
