import { describe, expect, it, vi } from 'vitest'
import type { ProjectDeletionRequest } from './deletion-store.js'
import { ProjectPurgeWorker, type ProjectPurgeWorkerOptions } from './worker.js'

const request: ProjectDeletionRequest = {
  id: 12,
  projectId: 7,
  slug: 'acme',
  name: 'Acme',
  requestedAt: new Date('2026-08-21T10:00:00Z'),
  claimedAt: null,
  completedAt: null,
  attempts: 1,
  lastError: null,
}

function makeWorker(overrides: Partial<ProjectPurgeWorkerOptions> = {}) {
  return new ProjectPurgeWorker({
    claim: async () => request,
    purge: async () => ({ deleted: true, remaining: {} }),
    complete: async () => {},
    fail: async () => {},
    intervalMs: 1000,
    leaseMs: 60_000,
    maxAttempts: 5,
    onError: () => {},
    ...overrides,
  })
}

describe('ProjectPurgeWorker', () => {
  it('completes a request whose purge deleted the project', async () => {
    const complete = vi.fn(async () => {})
    const worker = makeWorker({ complete })
    expect(await worker.runOnce()).toBe('purged')
    expect(complete).toHaveBeenCalledWith(request.id)
  })

  // The pin that stops a partial teardown reporting success.
  it('does NOT complete a request whose purge left rows behind', async () => {
    const complete = vi.fn(async () => {})
    const fail = vi.fn(async () => {})
    const worker = makeWorker({
      purge: async () => ({ deleted: false, remaining: { events: 3 } }),
      complete,
      fail,
    })
    expect(await worker.runOnce()).toBe('failed')
    expect(complete).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(request.id, expect.stringContaining('events=3'))
  })

  it('never rejects when purge throws synchronously', async () => {
    const onError = vi.fn()
    const worker = makeWorker({
      purge: () => {
        throw new Error('boom')
      },
      onError,
    })
    await expect(worker.runOnce()).resolves.toBe('failed')
    expect(onError).toHaveBeenCalled()
  })

  it('records the failure against the request when purge throws', async () => {
    const fail = vi.fn(async () => {})
    const worker = makeWorker({
      purge: async () => {
        throw new Error('ClickHouse unreachable')
      },
      fail,
    })
    await worker.runOnce()
    expect(fail).toHaveBeenCalledWith(request.id, expect.stringContaining('ClickHouse unreachable'))
  })

  it('is idle when nothing is claimable', async () => {
    const worker = makeWorker({ claim: async () => null })
    expect(await worker.runOnce()).toBe('idle')
  })

  it('stops claiming after stop()', async () => {
    const claim = vi.fn(async () => request)
    const worker = makeWorker({ claim })
    worker.stop()
    expect(await worker.runOnce()).toBe('idle')
    expect(claim).not.toHaveBeenCalled()
  })

  it('does not run two cycles concurrently', async () => {
    let inFlight = 0
    let peak = 0
    const worker = makeWorker({
      purge: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight -= 1
        return { deleted: true, remaining: {} }
      },
    })
    await Promise.all([worker.runOnce(), worker.runOnce()])
    expect(peak).toBe(1)
  })
})
