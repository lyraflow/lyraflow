import { describe, expect, it, vi } from 'vitest'
import { logDroppedPartition } from './logging.js'
import type { DropResult } from './store.js'

describe('logDroppedPartition', () => {
  it('logs a genuinely dropped result at info, naming project, table and partition', () => {
    const info = vi.fn()
    const result: DropResult = { projectId: 7, table: 'events', partition: 202401, dropped: true }

    logDroppedPartition({ info }, result)

    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      { projectId: 7, table: 'events', partition: 202401 },
      'retention dropped partition',
    )
  })

  // The mutation this guards against: `if (!result.dropped) return` deleted
  // (equivalent to always logging). `RetentionStore`'s real, production call
  // path never invokes `onDrop` with `dropped: false` (dryRun is hardcoded
  // false in app.ts's wiring), so this fabricates the input a genuine dry
  // run — or any future caller of this exported function — could produce,
  // to prove the guard is load-bearing rather than untestable dead code.
  it('logs nothing for a dropped: false result', () => {
    const info = vi.fn()
    const result: DropResult = { projectId: 1, table: 'events', partition: 202401, dropped: false }

    logDroppedPartition({ info }, result)

    expect(info).not.toHaveBeenCalled()
  })

  it('logs once per call, immediately — proving this is not a batching or count-collapsing shape', () => {
    const info = vi.fn()
    const calls: string[] = []
    const log = {
      info: (fields: Record<string, unknown>, msg: string) => {
        calls.push(msg)
        info(fields, msg)
      },
    }

    logDroppedPartition(log, { projectId: 1, table: 'events', partition: 202401, dropped: true })
    // A caller can observe the FIRST line before the second call ever
    // happens — nothing here buffers across multiple partitions the way a
    // wrapper reading a whole `dropExpired` result array would.
    expect(calls).toEqual(['retention dropped partition'])
    logDroppedPartition(
      { info },
      { projectId: 1, table: 'device_index', partition: 202401, dropped: true },
    )

    expect(info).toHaveBeenCalledTimes(2)
  })
})
