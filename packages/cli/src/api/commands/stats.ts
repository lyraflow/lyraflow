/**
 * `lyraflow stats` — time-bucketed event counts, the other half of "is my
 * instrumentation working": `events` answers "what happened", this answers
 * "how much, over time".
 */

import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Column, emitRecords, resolveMode } from '../output.js'
import {
  assertWindowNotInverted,
  checkNoPositionals,
  reportCommandFailure,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

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

/** Never echoes `raw` — see `resolveInstant`'s docstring (args.ts) for the
 * rule and the four times this class shipped before it was one. The valid
 * set is small enough to print in full, which is a better diagnostic than
 * repeating the typo back anyway. */
function parseInterval(raw: string): Interval {
  if (!isValidInterval(raw)) {
    throw new UsageError('--interval must be one of "1m", "1h", "1d"')
  }
  return raw
}

/**
 * The server's own default window WIDTH per interval
 * (`STATS_DEFAULT_WINDOW_MS`, events/routes.ts). Pinned against that
 * source directly in `stats.test.ts` (the same technique `events.test.ts`
 * uses for `EVENTS_MAX_LIMIT`/`EVENTS_DEFAULT_LIMIT`), not merely
 * hand-copied and trusted to stay in sync. `1m` → 1h, `1h` → 24h, `1d` →
 * 7d.
 */
export const DEFAULT_WINDOW_MS: Record<Interval, number> = {
  '1m': 60 * 60_000,
  '1h': 24 * 60 * 60_000,
  '1d': 7 * 24 * 60 * 60_000,
}

/**
 * The CLI's own default `since` when omitted.
 *
 * TWO DIFFERENT CASES, because the server's own default behaves
 * differently depending on whether `until` was given:
 *
 * 1. `--until` WAS given, `--since` was not: `since` is always computed
 *    here, anchored to the caller's own `until` — at every interval, not
 *    only `1h`. This is the one case that cannot be left to the server: the
 *    server's own default (`since ?? now - STATS_DEFAULT_WINDOW_MS`,
 *    routes.ts) always anchors to ITS OWN `Date.now()`, never to a
 *    caller-supplied `until`. Leaving `since` unsent here would pair a
 *    real, current-time-anchored default window with a caller's possibly
 *    stale `until` — silently producing an effectively inverted or
 *    badly-mismatched window server-side, for every interval, not just the
 *    non-default ones. (Confirmed directly: `--interval 1m` with a past
 *    `--until` and no `--since` returned zero rows with exit 0 before this
 *    fix — the server computed `since` from real `now`, miles past the
 *    given `until`.)
 * 2. `--until` was NOT given either: unchanged from the original behaviour
 *    — 24h, but only at the default (`1h`) interval. At any other interval
 *    a flat 24h figure would overshoot the server's own bucket-count
 *    ceiling (`STATS_MAX_BUCKETS`, events/routes.ts) for the one call
 *    shape that can least afford to be told to narrow it — a bare
 *    `--interval 1m` with nothing else. `since` is simply left unsent in
 *    that case, so the server's own default window (anchored to its own
 *    `now`, which is exactly correct when there is no `until` to disagree
 *    with) applies instead.
 *
 * For the record (so Task 10's docs can state all three truthfully): the
 * server's other two per-interval defaults are `1m` → 1h, `1d` → 7d
 * (`STATS_DEFAULT_WINDOW_MS`) — this CLI's 24h figure at `1h` is that same
 * table's `1h` entry, computed here instead of left to the server, purely
 * so the resolved `since` is visible in `--json` output like every other
 * explicit query parameter.
 */
function defaultSince(interval: Interval, until: Date | undefined, now: Date): Date | undefined {
  if (until) {
    return new Date(until.getTime() - DEFAULT_WINDOW_MS[interval])
  }
  if (interval !== '1h') return undefined
  return new Date(now.getTime() - DEFAULT_WINDOW_MS['1h'])
}

/**
 * `lyraflow stats [--since] [--until] [--interval] [--by-event] [--json|--human]`
 *
 * Returns the process exit code: 0 success, 1 the request failed, 2 usage
 * error.
 */
export async function runStats(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['since', 'until', 'interval', 'host', 'server-key'],
      booleans: ['by-event', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)

  const positionalsCode = checkNoPositionals(
    { positionals, positionalIndexes, positionalContext },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  let interval: Interval
  let since: Date | undefined
  let until: Date | undefined
  try {
    // All validated, and validation complete, before any network call —
    // same rule `events` follows, for the same reason.
    interval = typeof flags.interval === 'string' ? parseInterval(flags.interval) : '1h'
    // `until` resolved BEFORE `since`'s default is computed — the default
    // needs to know it, per defaultSince's own docstring.
    if (typeof flags.until === 'string') {
      until = resolveInstant(flags.until, ctx.now(), '--until')
    }
    since =
      typeof flags.since === 'string'
        ? resolveInstant(flags.since, ctx.now(), '--since')
        : defaultSince(interval, until, ctx.now())
    assertWindowNotInverted(since, until)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportUsageError(err, mode, ctx)
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
    return reportCommandFailure(err, mode, ctx)
  }
}
