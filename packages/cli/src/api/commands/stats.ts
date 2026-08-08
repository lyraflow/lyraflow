/**
 * `lyraflow stats` — time-bucketed event counts, the other half of "is my
 * instrumentation working": `events` answers "what happened", this answers
 * "how much, over time".
 */

import type { CommandContext } from '../../index.js'
import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import { ApiError } from '../client.js'
import { type Column, emitError, emitRecords, resolveMode } from '../output.js'

/** One row of GET /v1/events/stats — flat, per events/routes.ts's own docstring on why. */
interface StatsBucket {
  bucket: string
  event_name?: string
  events: number
}

interface StatsResponse {
  buckets: StatsBucket[]
}

/**
 * Human-mode table columns. `event_name` renders as `''` rather than the
 * literal string `"undefined"` when the response has no such field (i.e.
 * `--by-event` was not passed) — a deliberate `??` per output.ts's own
 * note on `Column.get` and missing fields. Task 9 depends on these exact
 * field names.
 */
const STATS_COLUMNS: Column[] = [
  { header: 'bucket', get: (row: StatsBucket) => row.bucket },
  { header: 'event_name', get: (row: StatsBucket) => row.event_name ?? '' },
  { header: 'events', get: (row: StatsBucket) => String(row.events) },
]

const VALID_INTERVALS = ['1m', '1h', '1d'] as const
type Interval = (typeof VALID_INTERVALS)[number]

function isValidInterval(value: string): value is Interval {
  return (VALID_INTERVALS as readonly string[]).includes(value)
}

function parseInterval(raw: string): Interval {
  if (!isValidInterval(raw)) {
    throw new UsageError(`--interval must be one of "1m", "1h", "1d", got "${raw}"`)
  }
  return raw
}

/**
 * The CLI's own default `since` when omitted: 24 hours, matching the
 * documented default at the default (`1h`) interval. At any other interval
 * a flat 24h figure would overshoot the server's own bucket-count ceiling
 * (`STATS_MAX_BUCKETS`, events/routes.ts) for the one call shape that can
 * least afford to be told to narrow it — a bare `--interval 1m` with
 * nothing else. Rather than duplicate the server's own per-interval
 * scaling here (`STATS_DEFAULT_WINDOW_MS` — a constant this package has no
 * dependency on and should not track for drift), `since` is simply left
 * unsent at any non-default interval, so the server's own default window
 * applies instead.
 */
function defaultSince(interval: Interval, now: Date): Date | undefined {
  if (interval !== '1h') return undefined
  return new Date(now.getTime() - 24 * 60 * 60 * 1000)
}

/**
 * `lyraflow stats [--since] [--until] [--interval] [--by-event] [--json|--human]`
 *
 * Returns the process exit code: 0 success, 1 the request failed, 2 usage
 * error.
 */
export async function runStats(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  try {
    ;({ flags } = parseCommandArgs(argv, {
      strings: ['since', 'until', 'interval', 'host', 'server-key'],
      booleans: ['by-event', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    emitError(err, resolveMode({}, ctx.isTty), ctx.writeErr)
    return 2
  }

  const mode = resolveMode(flags, ctx.isTty)

  let interval: Interval
  let since: Date | undefined
  let until: Date | undefined
  try {
    // All validated, and validation complete, before any network call —
    // same rule `events` follows, for the same reason.
    interval = typeof flags.interval === 'string' ? parseInterval(flags.interval) : '1h'
    since =
      typeof flags.since === 'string'
        ? resolveInstant(flags.since, ctx.now())
        : defaultSince(interval, ctx.now())
    if (typeof flags.until === 'string') {
      until = resolveInstant(flags.until, ctx.now())
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    emitError(err, mode, ctx.writeErr)
    return 2
  }

  const byEvent = flags['by-event'] === true

  try {
    const res = await ctx.client.get<StatsResponse>('/v1/events/stats', {
      since: since?.toISOString(),
      until: until?.toISOString(),
      interval,
      group_by: byEvent ? 'event_name' : undefined,
    })
    emitRecords(res.buckets, mode, STATS_COLUMNS, ctx.write)
    return 0
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    emitError(err, mode, ctx.writeErr)
    return 1
  }
}
