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
 * rather than a drifting one. `--until` rides along on EVERY poll, cursor
 * or not — unlike `since` it never drifts and never re-scans anything, and
 * the server applies it unconditionally regardless of `after`
 * (events/routes.ts's `untilClause`), so dropping it from the cursor
 * branch would silently ignore a bound the caller explicitly asked for.
 *
 * The API takes absolute times only (see resolveInstant in args.ts) — a
 * relative duration on the wire would mean "relative to whose clock", the
 * server's or the caller's. `--since`/`--until` are resolved to real
 * instants here, once, before the first request.
 *
 * A CURSORLESS POLL IS DELIBERATELY A TAIL, NOT A FULL SCAN. With no
 * cursor, the server answers "the most recent `limit` events in the
 * window" (events/routes.ts: DESC then reversed) — not "every event in the
 * window". That is correct for a human staring at a terminal, and it is
 * also the one place `--follow` can silently and PERMANENTLY lose events:
 * if a burst larger than `limit` arrives while the loop has no cursor yet
 * (the very first poll, or any poll right after an empty one), the poll
 * returns only the newest page of that burst, the loop then advances past
 * everything older, and `next_cursor` never looks backwards again. This
 * command cannot recover those events after the fact — re-polling with the
 * new cursor gets what comes AFTER the newest row shown, never the older
 * rows the full page pushed out. What it CAN do, and does: always send an
 * explicit `limit` so it can tell a full page from a partial one, and warn
 * on stderr whenever a cursorless poll comes back exactly full, naming the
 * oldest event shown so the reader can re-query with an earlier `--since`.
 * See the full-page check inside the loop below.
 */

import { UsageError, hasRawFlag, parseCommandArgs, resolveInstant } from '../args.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
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
 * Matches the server's own defaults (EVENTS_MAX_LIMIT, events/routes.ts):
 * 50 when the caller doesn't pass `--limit`, 500 as the hard ceiling. The
 * CLI validates the ceiling itself rather than letting an over-large
 * `--limit` cost a round trip for an opaque `400 {"error":"invalid_query"}`
 * — the same reasoning `stats`' own `--interval` validation follows.
 *
 * `limit` is now ALWAYS resolved to a real number, never left `undefined`
 * — every poll sends an explicit `limit`, which is what lets the full-page
 * check below tell "the window had exactly `limit` events" apart from "the
 * window had more than `limit` events and the rest were silently dropped".
 */
const EVENTS_DEFAULT_LIMIT = 50
const EVENTS_MAX_LIMIT = 500

/**
 * `--limit` has no numeric ArgSpec type (Task 5's known gap) — it arrives
 * as a string and is validated here. A bad value is a UsageError (exit 2),
 * never a silent default and never sent to the server to fail there instead.
 */
function parseLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--limit must be a positive integer, got "${raw}"`)
  }
  const n = Number(raw)
  if (n > EVENTS_MAX_LIMIT) {
    throw new UsageError(`--limit must be at most ${EVENTS_MAX_LIMIT}, got "${raw}"`)
  }
  return n
}

/** EPIPE means the reader (e.g. `head`, `less`) closed the pipe before this
 * command was done writing — a normal end for a streaming command, not a
 * failure. Every write in this function's main loop goes through a catch
 * that checks this, so a closed pipe always resolves to a clean exit 0
 * instead of an unhandled-exception stack trace and exit 1 (which under
 * this CLI's contract means "the request failed" — it did not). */
function isEpipe(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EPIPE'
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
 * `next_cursor` across separate process invocations. On a non-`--follow`
 * run, this command also writes its own final `next_cursor` to stderr (see
 * the end of the loop below) so that resumption is possible without a
 * separate API call.
 *
 * A cursorless poll that hits `--follow` on an `ApiError` (including a
 * `503`) exits 1 immediately rather than retrying — loud beats silent for
 * a first cut of this command; a caller that wants "keep trying through
 * transient failures" is a reasonable Task 10 addition, not assumed here.
 *
 * Returns the process exit code: 0 success, 1 the request failed (API
 * reached, rejected), 2 usage error (nothing was ever sent).
 */
export async function runEvents(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  try {
    ;({ flags, positionals } = parseCommandArgs(argv, {
      strings: ['since', 'until', 'event', 'person', 'limit', 'after', 'host', 'server-key'],
      booleans: ['follow', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    // The parse as a whole failed, so there is no ParsedArgs to read a mode
    // from — but a --json that DID appear in argv should still win here;
    // see hasRawFlag's docstring.
    const failMode = resolveMode(
      { json: hasRawFlag(argv, 'json'), human: hasRawFlag(argv, 'human') },
      ctx.isTty,
    )
    try {
      emitError(err, failMode, ctx.writeErr)
    } catch (writeErr) {
      if (!isEpipe(writeErr)) throw writeErr
    }
    return 2
  }

  const mode = resolveMode(flags, ctx.isTty)

  if (positionals.length > 0) {
    try {
      emitError(
        new UsageError(`unexpected argument(s): ${positionals.join(' ')}`),
        mode,
        ctx.writeErr,
      )
    } catch (writeErr) {
      if (!isEpipe(writeErr)) throw writeErr
    }
    return 2
  }

  let since: Date
  let until: Date | undefined
  let limit: number
  try {
    // Validated — and the process of validating it complete — before any
    // network call. A bad --since must never reach the API; see the "call
    // the API before validating --since" mutation this guards against.
    since = resolveInstant(typeof flags.since === 'string' ? flags.since : '15m', ctx.now())
    if (typeof flags.until === 'string') {
      until = resolveInstant(flags.until, ctx.now())
    }
    limit = typeof flags.limit === 'string' ? parseLimit(flags.limit) : EVENTS_DEFAULT_LIMIT
    if (until && since.getTime() > until.getTime()) {
      throw new UsageError(
        `--since (${since.toISOString()}) is after --until (${until.toISOString()})`,
      )
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    try {
      emitError(err, mode, ctx.writeErr)
    } catch (writeErr) {
      if (!isEpipe(writeErr)) throw writeErr
    }
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
      const hadCursor = cursor !== undefined

      // `--limit` and `--until` are resent on every poll, follow or not:
      // `--limit` is the per-poll page cap, not a total-events-ever-shown
      // cap (dropping it from later polls would silently widen every page
      // after the first); `--until` is a fixed bound that never drifts and
      // never re-scans anything, unlike `since`, which is the one field
      // that MUST NOT ride along once a cursor exists — see the module
      // docstring for why.
      const query: Record<string, string | number | undefined> = cursor
        ? { after: cursor, until: until?.toISOString(), event, person, limit }
        : { since: since.toISOString(), until: until?.toISOString(), event, person, limit }

      const res = await ctx.client.get<EventsResponse>('/v1/events', query)
      emitRecords(res.events, mode, EVENTS_COLUMNS, ctx.write)

      // THE CRITICAL CASE: a cursorless poll (first ever, or the first
      // after an empty one) that comes back with exactly `limit` events
      // cannot tell "that was everything" from "a burst pushed older
      // events out of the page" — the server has no way to say which, and
      // by the time the NEXT poll runs with the new cursor, the older rows
      // are unreachable forever (next_cursor only ever advances). This is
      // the one thing this command can still do about it: say so, loudly,
      // on stderr — never stdout, which must stay a pure record stream —
      // and name the oldest event actually shown so the reader knows where
      // to re-`--since` from.
      if (!hadCursor && res.events.length === limit) {
        const oldest = res.events[0]?.timestamp
        ctx.writeErr(
          `warning: this page hit --limit ${limit}; events older than ${oldest} in this window may exist and were not shown — rerun with --since ${oldest} (or earlier) to see them\n`,
        )
      }

      // Keyed on what this command itself observed (did any events come
      // back), not solely on `next_cursor`'s truthiness — the "no event
      // twice, none missed" guarantee should hold structurally rather than
      // resting on trusting a single external field in isolation, even
      // though today's server always sends a non-null next_cursor exactly
      // when events.length > 0 (see events/routes.ts). If it ever sent
      // events with no cursor, this deliberately does NOT advance rather
      // than guess.
      if (res.events.length > 0 && res.next_cursor) {
        cursor = res.next_cursor
      }

      if (!follow) {
        // Surfaced on stderr, not stdout — this is how a non-follow caller
        // can resume with --after later without a separate API call, and
        // it is also the only way to recover after the warning above.
        if (res.next_cursor) {
          ctx.writeErr(`next_cursor: ${res.next_cursor}\n`)
        }
        break
      }
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
    if (isEpipe(err)) return 0
    if (!(err instanceof ApiError)) throw err
    try {
      emitError(err, mode, ctx.writeErr)
    } catch (writeErr) {
      if (isEpipe(writeErr)) return 0
      throw writeErr
    }
    return 1
  }
}
