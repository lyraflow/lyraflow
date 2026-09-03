/**
 * How many tile runs a dashboard has in flight at once. Twelve concurrent
 * retention queries against a small ClickHouse is the shape that OOM-killed
 * the test stack once; a self-hoster's box is often that size. Three is a
 * number, not a finding -- one constant so a later measurement can move it.
 */
export const MAX_IN_FLIGHT = 3

export interface RunQueue {
  run<T>(task: () => Promise<T>): Promise<T>
  readonly inFlight: number
}

/** FIFO. A task starts when a slot is free and frees it when it settles,
 *  fulfilled or rejected; the rejection reaches only that task's caller. */
export function createRunQueue(limit = MAX_IN_FLIGHT): RunQueue {
  let inFlight = 0
  const waiting: (() => void)[] = []

  function next() {
    if (inFlight >= limit) return
    const start = waiting.shift()
    if (start) start()
  }

  return {
    get inFlight() {
      return inFlight
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          inFlight++
          task()
            .then(resolve, reject)
            .finally(() => {
              inFlight--
              next()
            })
        })
        next()
      })
    },
  }
}
