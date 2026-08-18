import { describe, expect, it, vi } from 'vitest'
import { dedupeInFlight } from './dedupe.js'

/** A promise whose settlement this test controls. */
function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('dedupeInFlight', () => {
  it('makes one call for identical concurrent callers, and gives them all the same answer', async () => {
    const g = gate<string[]>()
    const fn = vi.fn(async (_k: string) => g.promise)
    const deduped = dedupeInFlight(fn, (k: string) => k)

    const a = deduped('same')
    const b = deduped('same')
    const c = deduped('same')
    expect(fn).toHaveBeenCalledTimes(1)

    g.resolve(['x'])
    expect(await a).toEqual(['x'])
    expect(await b).toEqual(['x'])
    expect(await c).toEqual(['x'])
  })

  it('does not collapse different keys', async () => {
    const fn = vi.fn(async (k: string) => [k])
    const deduped = dedupeInFlight(fn, (k: string) => k)

    await Promise.all([deduped('a'), deduped('b')])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // The line between this and a cache. Nothing is retained once a request
  // settles, which is what keeps it free of staleness rules -- so a caller
  // arriving afterwards must reach the network again, not be served an old
  // answer.
  it('is not a cache: a call after the first settles goes out again', async () => {
    const fn = vi.fn(async () => ['x'])
    const deduped = dedupeInFlight(fn, () => 'k')

    await deduped()
    await deduped()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // A failed lookup must not pin its key. Retaining a rejected promise would
  // make every later attempt replay the same old failure forever, which is
  // worse than the duplicate requests this exists to remove.
  it('releases the key after a rejection, so a retry is a real request', async () => {
    const fn = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(['x'])
    const deduped = dedupeInFlight(fn, () => 'k')

    await expect(deduped()).rejects.toThrow('boom')
    expect(await deduped()).toEqual(['x'])
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('shares a rejection with every concurrent caller', async () => {
    const g = gate<string[]>()
    const fn = vi.fn(async () => g.promise)
    const deduped = dedupeInFlight(fn, () => 'k')

    const a = deduped()
    const b = deduped()
    g.reject(new Error('boom'))

    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
