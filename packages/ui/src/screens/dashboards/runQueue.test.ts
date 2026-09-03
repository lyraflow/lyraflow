import { describe, expect, it } from 'vitest'
import { MAX_IN_FLIGHT, createRunQueue } from './runQueue.js'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createRunQueue', () => {
  it('starts at most MAX_IN_FLIGHT tasks, and the next one when one settles', async () => {
    const q = createRunQueue()
    const started: number[] = []
    const gates = Array.from({ length: 12 }, () => deferred<number>())
    const results = gates.map((g, i) =>
      q.run(() => {
        started.push(i)
        return g.promise
      }),
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])
    expect(q.inFlight).toBe(MAX_IN_FLIGHT)
    gates[1]?.resolve(1)
    await results[1]
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2, 3])
    for (const [i, g] of gates.entries()) g.resolve(i)
    expect(await Promise.all(results)).toEqual(gates.map((_, i) => i))
    expect(q.inFlight).toBe(0)
  })

  it('a rejected task frees its slot and rejects its own caller only', async () => {
    const q = createRunQueue(1)
    const a = deferred<void>()
    const first = q.run(() => a.promise)
    const second = q.run(async () => 'ok')
    a.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe('ok')
  })
})
