import { describe, expect, it, vi } from 'vitest'
import { wrapWithDropLogging } from './logging.js'
import type { DropResult, RetentionTarget } from './store.js'

const target: RetentionTarget = { projectId: 7, retentionMonths: 13 }
const now = new Date()

describe('wrapWithDropLogging', () => {
  // The mutation this guards against: `if (r.dropped)` replaced with
  // `if (true)`. app.ts's own production store hardcodes `dryRun: false`,
  // so every result it ever produces has `dropped: true` — a test that only
  // exercises that store cannot tell the two conditions apart. This
  // fabricates a mixed result set (as a genuine dry run, or a future
  // partial-drop shape, could produce) to prove the check is load-bearing.
  it('logs only the results where dropped is true, never a candidate that was reported but not actually dropped', async () => {
    const results: DropResult[] = [
      { projectId: 7, table: 'events', partition: 202401, dropped: true },
      { projectId: 7, table: 'device_index', partition: 202401, dropped: false },
      { projectId: 7, table: 'events', partition: 202402, dropped: true },
    ]
    const info = vi.fn()
    const dropExpired = vi.fn(async () => results)

    const wrapped = wrapWithDropLogging(dropExpired, { info })
    const returned = await wrapped(target, now)

    expect(returned).toBe(results)
    expect(dropExpired).toHaveBeenCalledWith(target, now)
    expect(info).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenNthCalledWith(
      1,
      { projectId: 7, table: 'events', partition: 202401 },
      'retention dropped partition',
    )
    expect(info).toHaveBeenNthCalledWith(
      2,
      { projectId: 7, table: 'events', partition: 202402 },
      'retention dropped partition',
    )
  })

  it('logs nothing when every result is dropped: false', async () => {
    const results: DropResult[] = [
      { projectId: 1, table: 'events', partition: 202401, dropped: false },
      { projectId: 1, table: 'device_index', partition: 202401, dropped: false },
    ]
    const info = vi.fn()

    await wrapWithDropLogging(async () => results, { info })(target, now)

    expect(info).not.toHaveBeenCalled()
  })

  it('logs nothing and does not throw when there is nothing to report', async () => {
    const info = vi.fn()
    const returned = await wrapWithDropLogging(async () => [], { info })(target, now)
    expect(returned).toEqual([])
    expect(info).not.toHaveBeenCalled()
  })
})
