import { renderHook, waitFor } from '@testing-library/react'
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

  it('stops on unmount', async () => {
    const fn = vi.fn(async () => 1)
    const { unmount } = renderHook(() => usePolling(fn, 1000))
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
