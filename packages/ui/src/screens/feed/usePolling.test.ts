import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePolling } from './usePolling.js'

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

describe('usePolling', () => {
  it('calls immediately and then on the interval', async () => {
    const fn = vi.fn(async () => 1)
    renderHook(() => usePolling(fn, 3000))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(3000)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  // Without this, a slow request on a 3s interval stacks calls until the
  // browser is doing nothing but retrying, and the feed appears frozen.
  it('does not start a second call while one is in flight', async () => {
    let release: (v: number) => void = () => {}
    const fn = vi.fn(
      () =>
        new Promise<number>((r) => {
          release = r
        }),
    )
    renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
    release(1)
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  it('keeps polling after a rejection', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2))
  })

  // Feed's "showing data from N minutes ago" (issue #82) reads this value,
  // so it has to name when `data` actually arrived, not merely "recently".
  it('sets updatedAt when a poll succeeds', async () => {
    const fn = vi.fn(async () => 'ok')
    const before = Date.now()
    const { result } = renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(result.current.data).toBe('ok'))
    expect(result.current.updatedAt).not.toBeNull()
    expect(result.current.updatedAt as number).toBeGreaterThanOrEqual(before)
  })

  // The other half: a failing poll must NOT advance `updatedAt`, or the
  // "showing data from N minutes ago" label would silently understate how
  // stale the screen really is on every failed retry.
  it('does not advance updatedAt when a later poll fails', async () => {
    let succeed = true
    const fn = vi.fn(async () => {
      if (succeed) return 'ok'
      throw new Error('boom')
    })
    const { result } = renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(result.current.data).toBe('ok'))
    const firstUpdatedAt = result.current.updatedAt

    succeed = false
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.updatedAt).toBe(firstUpdatedAt)
  })

  it('stops on unmount', async () => {
    const fn = vi.fn(async () => 1)
    const { unmount } = renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  // Important 9 from the whole-branch review. `fn`'s identity changing is
  // the caller's own signal that the underlying query changed -- `Feed`
  // rebuilds its poll callbacks on `activeId` -- and the OLD `data` belongs
  // to the OLD query. Combined with "keeps polling after a rejection"
  // above (data is never cleared on error), leaving `data` in place across
  // an `fn` change is exactly how switching to a project whose poll then
  // fails pins the previous project's rows on screen under the new
  // project's name indefinitely.
  it('resets data and error when fn identity changes, so a fresh query never shows a stale answer', async () => {
    const fnAlpha = vi.fn(async () => 'alpha-data')
    let releaseBeta: (v: string) => void = () => {}
    const fnBeta = vi.fn(
      () =>
        new Promise<string>((r) => {
          releaseBeta = r
        }),
    )

    const { result, rerender } = renderHook(({ fn }) => usePolling(fn, 1000), {
      initialProps: { fn: fnAlpha as () => Promise<string> },
    })
    await waitFor(() => expect(result.current.data).toBe('alpha-data'))

    act(() => {
      rerender({ fn: fnBeta })
    })
    // Before fnBeta's own promise has even settled: the reset must be
    // synchronous with the fn change, not something that waits for the
    // new poll to complete.
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.updatedAt).toBeNull()

    releaseBeta('beta-data')
    await waitFor(() => expect(result.current.data).toBe('beta-data'))
  })

  // The other half: intervalMs changing ALONE (fn's own identity unchanged)
  // must not reset -- that would throw away rows that are still valid for
  // the identical query, the same "never clear data" guarantee the
  // rejection test above pins for a failed poll.
  it('does not reset data when only intervalMs changes', async () => {
    const fn = vi.fn(async () => 'steady-data')
    const { result, rerender } = renderHook(({ ms }) => usePolling(fn, ms), {
      initialProps: { ms: 1000 },
    })
    await waitFor(() => expect(result.current.data).toBe('steady-data'))

    act(() => {
      rerender({ ms: 2000 })
    })
    expect(result.current.data).toBe('steady-data')
  })
})
