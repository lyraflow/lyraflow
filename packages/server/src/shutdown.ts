import type { FastifyInstance } from 'fastify'
import type { Readiness } from './health.js'
import type { IngestBuffer } from './ingest/buffer.js'
import type { IngestCounters } from './ingest/counters.js'
import type { EventRow } from './ingest/row.js'
import { flushLogger } from './log-flush.js'

// See log-flush.ts and index.ts's identical constant: bounds how long a
// flush can delay exit() before this module gives up and exits anyway.
const LOG_FLUSH_TIMEOUT_MS = 1000

export interface ShutdownOptions {
  app: FastifyInstance
  readiness: Readiness
  buffer: IngestBuffer<EventRow>
  counters: IngestCounters
  // The narrowest type that says what shutdown needs — not `PurgeWorker`
  // itself — so a test can pass a stub without a database.
  purge: { stop(): void }
  // Same narrowing, and stopped for a DIFFERENT reason than `purge` is:
  // `RetentionWorker.stop()` cannot make an in-flight drop reversible, but it
  // stops the NEXT one from starting mid-shutdown, and — the part that
  // actually matters — it stops Guard 5's log line from being the only
  // record of a drop that happens after the process has decided it is going
  // away. `dropExpired` logs per project, not per partition-across-the-whole-
  // run, so a SIGTERM arriving between two projects' drops previously lost
  // every already-executed drop from the project(s) still in flight when the
  // signal landed, with no line ever written for them — the exact gap Guard
  // 5 exists to close. See retention/worker.ts's own docstring for why
  // `stop()` not awaiting the in-flight run is still safe: a drop already
  // issued to ClickHouse completes server-side regardless.
  retention: { stop(): void }
  drainDeadlineMs: number
  onExit?: (code: number) => void
}

/**
 * The other half of the `202` contract. Without this, every `docker compose
 * down` — including the documented upgrade path — silently discards whatever
 * is buffered, which would make the upgrade story dishonest.
 */
export function installShutdownHandlers(opts: ShutdownOptions): () => Promise<void> {
  const { app, readiness, buffer, counters, purge, retention, drainDeadlineMs } = opts
  const exit = opts.onExit ?? ((code: number) => process.exit(code))
  let running: Promise<void> | null = null

  async function shutdown(): Promise<void> {
    if (running) return running
    running = (async () => {
      app.log.info('shutdown: draining')
      readiness.markDraining()

      // No new purges once draining starts. A mutation already in flight is
      // left to ClickHouse — it completes server-side regardless — and the
      // lease brings the request back on the next boot if completed_at never
      // landed. Deliberately not awaited: the drain deadline belongs to the
      // ingest buffer, whose rows are only in this process's memory and are
      // lost if it is missed. A purge is durable in Postgres and is not.
      purge.stop()
      // Same reasoning, plus Guard 5: stopping here bounds how much of a
      // still-running project's drops can ever complete with no log line —
      // see this option's own docstring above.
      retention.stop()

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
      // Same reasoning as index.ts's migration-failure path: the line just
      // above (the drain outcome — success or, more importantly, the
      // "still buffered" error) is the one an operator needs, and
      // process.exit() can otherwise beat pino's async stdout write to it.
      await flushLogger(app.log, LOG_FLUSH_TIMEOUT_MS)
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
      // This callback is `async` — its `.catch()`-returned promise is never
      // awaited by anyone, same as it would have been for a synchronous
      // callback here. That's a pre-existing, already-accepted property of
      // this exact call site (a synchronous `app.log.error` throw would
      // have had the identical fate before this change), not something
      // `async` introduces. flushLogger() itself never rejects, so it adds
      // no new risk on top of what was already accepted here.
      shutdown().catch(async (err: unknown) => {
        app.log.error({ err }, 'shutdown failed unexpectedly')
        await flushLogger(app.log, LOG_FLUSH_TIMEOUT_MS)
        exit(1)
      })
    })
  }

  return shutdown
}
