import type { FastifyBaseLogger } from 'fastify'

// The one method flushLogger needs from pino's Logger — narrower than
// pino's own type, and easier to fake in tests than importing it just for
// this.
interface FlushableLogger {
  flush(cb?: (err?: Error) => void): void
}

/**
 * Flushes a pino-backed logger and never rejects or hangs doing it. Meant to
 * be awaited immediately before a `process.exit()` that follows a log call
 * the caller actually needs an operator to see.
 *
 * Why this exists: pino's default stdout destination (SonicBoom) writes
 * asynchronously when stdout is a pipe — the normal case under Docker.
 * `process.exit()` can terminate the process before that write lands,
 * silently dropping the one diagnostic line a log-then-exit call site
 * exists to produce. `logger.flush(cb)` is pino's own answer to this, but
 * it isn't on `FastifyBaseLogger`'s type — Fastify's public logger
 * interface deliberately excludes pino-specific methods so the logger stays
 * swappable — so it's reached here through a narrow, justified cast rather
 * than `any`, guarded by a runtime existence check: `Fastify({ logger:
 * false })` (used throughout this repo's test harnesses) installs a no-op
 * logger with no `flush` at all, and must resolve immediately rather than
 * waiting out the timeout below.
 *
 * Two failure modes are guarded deliberately, both because this runs
 * fire-and-forget on a path that is already handling one failure — a second
 * failure here (a stalled destination, a throwing `flush`) must never mask
 * the first, un-logged one:
 *  - `flush()` never invoking its callback is bounded by `timeoutMs`, so a
 *    stalled or misbehaving destination cannot hang shutdown;
 *  - `flush()` throwing synchronously, or invoking its callback with an
 *    error, both resolve rather than reject — there is nothing the caller
 *    could usefully do differently for either, and this function's whole
 *    purpose is to run safely right before the process ends.
 */
export async function flushLogger(logger: FastifyBaseLogger, timeoutMs: number): Promise<void> {
  const flushable = logger as unknown as Partial<FlushableLogger>
  if (typeof flushable.flush !== 'function') return

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const timer = setTimeout(finish, timeoutMs)
    // This function is always called right before the process exits — never
    // a reason, on its own, to keep the event loop alive.
    timer.unref()

    try {
      flushable.flush?.(() => finish())
    } catch {
      finish()
    }
  })
}
