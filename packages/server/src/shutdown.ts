import type { FastifyInstance } from 'fastify'
import type { Readiness } from './health.js'
import type { IngestBuffer } from './ingest/buffer.js'
import type { IngestCounters } from './ingest/counters.js'
import type { EventRow } from './ingest/row.js'

export interface ShutdownOptions {
  app: FastifyInstance
  readiness: Readiness
  buffer: IngestBuffer<EventRow>
  counters: IngestCounters
  drainDeadlineMs: number
  onExit?: (code: number) => void
}

/**
 * The other half of the `202` contract. Without this, every `docker compose
 * down` — including the documented upgrade path — silently discards whatever
 * is buffered, which would make the upgrade story dishonest.
 */
export function installShutdownHandlers(opts: ShutdownOptions): () => Promise<void> {
  const { app, readiness, buffer, counters, drainDeadlineMs } = opts
  const exit = opts.onExit ?? ((code: number) => process.exit(code))
  let running: Promise<void> | null = null

  async function shutdown(): Promise<void> {
    if (running) return running
    running = (async () => {
      app.log.info('shutdown: draining')
      readiness.markDraining()

      const result = await buffer.drain(drainDeadlineMs)
      if (result.dropped > 0) {
        app.log.error(
          { dropped: result.dropped },
          'shutdown: drain deadline passed with rows still buffered',
        )
      } else {
        app.log.info({ flushed: result.flushed }, 'shutdown: drain complete')
      }

      // counters.flush() never rejects (failures surface via its onError
      // callback, already wired by buildApp) — awaited bare, not chained
      // with .catch(), because a bare `await` is what actually needs that
      // guarantee to hold; a .catch() here would be redundant at best and
      // misleading at worst about where the safety actually comes from.
      await counters.flush()
      await app.close()
      exit(result.dropped > 0 ? 1 : 0)
    })()
    return running
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // `shutdown` is `async`, so calling it can never throw synchronously —
    // any throw inside its body becomes a rejection of the returned promise,
    // not an exception at the call site — so `.catch()` here is guaranteed
    // to see every failure, unlike a plain function returning a promise.
    // The handler itself must still be attached: `shutdown()` is invoked
    // fire-and-forget from a signal, and an unhandled rejection here would
    // crash the process before the drain it was trying to protect finishes,
    // which is precisely the durability loss this function exists to avoid.
    process.on(signal, () => {
      shutdown().catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed unexpectedly')
        exit(1)
      })
    })
  }

  return shutdown
}
