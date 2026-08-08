/**
 * `lyraflow events` — the event feed ("what happened, recently") and its
 * `--follow` tail mode ("what is happening now").
 *
 * THE WHOLE POINT OF `--follow`: no event twice, none missed. Once a poll
 * has returned a `next_cursor`, every later poll in the same session asks
 * for `after: <cursor>` and nothing else — never `since`. Stacking a `since`
 * window on top of a cursor is exactly the bug GET /v1/events itself
 * shipped and fixed (see events/routes.ts's DEFAULT_SINCE_MS comment): a
 * caller more than 24h behind would have every event between the cursor
 * and the window edge silently, permanently dropped, because `next_cursor`
 * only ever advances. This command never recomputes `since` from "now" on
 * a later poll either — the resolved `since` is fixed once, at command
 * start, so a poll that finds nothing yet re-asks the same fixed origin
 * rather than a drifting one.
 *
 * The API takes absolute times only (see resolveInstant in args.ts) — a
 * relative duration on the wire would mean "relative to whose clock", the
 * server's or the caller's. `--since`/`--until` are resolved to real
 * instants here, once, before the first request.
 */

import type { CommandContext } from '../../index.js'
import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import { ApiError } from '../client.js'
import { type Column, emitError, emitRecords, resolveMode } from '../output.js'

/** One row of GET /v1/events — the full server contract (events/routes.ts's FeedRow). */
interface EventRecord {
  event_id: string
  timestamp: string
  event_name: string
  anonymous_id: string
  user_id: string
  properties: Record<string, string>
  properties_num: Record<string, number>
  url: string
  path: string
  referrer: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_term: string
  utm_content: string
  device_type: string
  os: string
  browser: string
  country: string
  region: string
  city: string
}

interface EventsResponse {
  events: EventRecord[]
  next_cursor: string | null
}

/**
 * Human-mode table columns. `json` mode always emits the full record (see
 * output.ts's module docstring) — this subset is only what fits a terminal
 * line without wrapping: when it happened, what it was, who it was, and
 * where. Task 9 depends on these exact field names.
 */
const EVENTS_COLUMNS: Column[] = [
  { header: 'timestamp', get: (row: EventRecord) => row.timestamp },
  { header: 'event_name', get: (row: EventRecord) => row.event_name },
  { header: 'user_id', get: (row: EventRecord) => row.user_id },
  { header: 'anonymous_id', get: (row: EventRecord) => row.anonymous_id },
  { header: 'path', get: (row: EventRecord) => row.path },
]

/** How often `--follow` polls. Fixed, not configurable — a tail is not a page. */
const FOLLOW_POLL_MS = 2000

/**
 * `--limit` has no numeric ArgSpec type (Task 5's known gap) — it arrives
 * as a string and is validated here. A bad value is a UsageError (exit 2),
 * never a silent default and never sent to the server to fail there instead.
 */
function parseLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--limit must be a positive integer, got "${raw}"`)
  }
  return Number(raw)
}

/**
 * `lyraflow events [--since] [--until] [--event] [--person] [--limit]
 *   [--after] [--follow] [--json|--human]`
 *
 * `--since` defaults to the last 15 minutes when omitted — a CLI-level
 * default distinct from the server's own (24h, only when there is no
 * cursor at all; see events/routes.ts). 15 minutes is deliberately
 * narrower: "is my instrumentation working right now" is the question this
 * command exists to answer, and a human staring at a terminal wants the
 * last few minutes, not a full day scrolling past.
 *
 * `--after` seeds the very first poll's cursor directly — the same
 * "cursor, never since" rule `--follow` uses internally, available even
 * without `--follow` so an agent can resume a previous session's
 * `next_cursor` across separate process invocations.
 *
 * Returns the process exit code: 0 success, 1 the request failed (API
 * reached, rejected), 2 usage error (nothing was ever sent).
 */
export async function runEvents(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  try {
    ;({ flags } = parseCommandArgs(argv, {
      strings: ['since', 'until', 'event', 'person', 'limit', 'after', 'host', 'server-key'],
      booleans: ['follow', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    emitError(err, resolveMode({}, ctx.isTty), ctx.writeErr)
    return 2
  }

  const mode = resolveMode(flags, ctx.isTty)

  let since: Date
  let until: Date | undefined
  let limit: number | undefined
  try {
    // Validated — and the process of validating it complete — before any
    // network call. A bad --since must never reach the API; see the "call
    // the API before validating --since" mutation this guards against.
    since = resolveInstant(typeof flags.since === 'string' ? flags.since : '15m', ctx.now())
    if (typeof flags.until === 'string') {
      until = resolveInstant(flags.until, ctx.now())
    }
    if (typeof flags.limit === 'string') {
      limit = parseLimit(flags.limit)
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    emitError(err, mode, ctx.writeErr)
    return 2
  }

  const event = typeof flags.event === 'string' ? flags.event : undefined
  const person = typeof flags.person === 'string' ? flags.person : undefined
  const follow = flags.follow === true

  // A caller-supplied --after resumes a previous cursor directly, bypassing
  // `since` from the very first poll — exactly the shape `--follow`'s own
  // loop settles into below once it has one.
  let cursor = typeof flags.after === 'string' ? flags.after : undefined

  try {
    for (;;) {
      // `--limit` is resent on every poll, follow or not — it is the
      // per-poll page cap, not a total-events-ever-shown cap. A `--follow`
      // session that "kept the limit as its per-poll cap" is the whole
      // point: dropping it from later polls would silently widen every
      // page after the first.
      const query: Record<string, string | number | undefined> = cursor
        ? { after: cursor, event, person, limit }
        : { since: since.toISOString(), until: until?.toISOString(), event, person, limit }

      const res = await ctx.client.get<EventsResponse>('/v1/events', query)
      emitRecords(res.events, mode, EVENTS_COLUMNS, ctx.write)

      // See the module docstring: next_cursor only ever advances, and an
      // empty page (next_cursor === null) means "nothing new since the
      // last one you have" — the existing cursor is kept exactly as is,
      // never replaced by a fresh `since` window.
      if (res.next_cursor) cursor = res.next_cursor

      if (!follow) break
      try {
        await ctx.sleep(FOLLOW_POLL_MS)
      } catch {
        // A cancelled sleep (e.g. an AbortController wired to SIGINT by the
        // real dispatch) ends the follow session cleanly — this is a
        // normal stop, not a failure, so it still exits 0.
        break
      }
    }
    return 0
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    emitError(err, mode, ctx.writeErr)
    return 1
  }
}
