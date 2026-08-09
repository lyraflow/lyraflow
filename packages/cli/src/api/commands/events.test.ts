import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT, runEvents } from './events.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')

interface FakeCall {
  path: string
  query: Record<string, string | number | undefined>
}

/**
 * `responses` is consumed one per call; the last entry repeats once
 * exhausted, so a test that only cares about the first two polls can
 * still let a `--follow` loop run a third time (e.g. on its way to being
 * cancelled) without needing an extra fixture entry.
 */
function makeClient(responses: unknown[]): { client: Client; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client = {
    get: async (path: string, query: Record<string, string | number | undefined> = {}) => {
      calls.push({ path, query })
      const idx = Math.min(calls.length - 1, responses.length - 1)
      const res = responses[idx]
      if (res instanceof Error) throw res
      return res
    },
  }
  return { client: client as unknown as Client, calls }
}

/** `write`/`writeErr` throwing this is exactly what a real broken pipe
 * (`| head`) looks like as a SYNCHRONOUS throw — see events.ts's `isEpipe`
 * docstring for why that is only half the real story, and
 * index.epipe.test.ts for the other half (the real, asynchronous case). */
function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

function makeCtx(
  client: Client,
  overrides: Partial<CommandContext> = {},
): { ctx: CommandContext; out: string[]; errOut: string[] } {
  const out: string[] = []
  const errOut: string[] = []
  return {
    ctx: {
      client,
      isTty: false,
      write: (s) => out.push(s),
      writeErr: (s) => errOut.push(s),
      now: () => NOW,
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('runEvents should never prompt')),
      ...overrides,
    },
    out,
    errOut,
  }
}

/** Parses every non-empty line of `errOut` as JSON — valid whenever `mode`
 * is `'json'`, which every `makeCtx` in this file defaults to (`isTty:
 * false`, no `--json`/`--human` passed). */
function parseErrLines(errOut: string[]): Record<string, unknown>[] {
  return errOut
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const EMPTY_PAGE = { events: [], next_cursor: null }

interface FakeEventRecord {
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

function makeEvent(overrides: Partial<FakeEventRecord> = {}): FakeEventRecord {
  return {
    event_id: 'e1',
    timestamp: '2026-08-08T11:50:00.000Z',
    event_name: 'page_view',
    anonymous_id: 'anon-1',
    user_id: '',
    properties: {},
    properties_num: {},
    url: 'https://example.com/',
    path: '/',
    referrer: '',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    device_type: '',
    os: '',
    browser: '',
    country: '',
    region: '',
    city: '',
    ...overrides,
  }
}

/** `n` events, ascending timestamp order, one second apart, ending one
 * second before `NOW` — always inside the CLI's own 15-minute default
 * `--since` window for any `n` well under 900. */
function makeBurst(n: number): FakeEventRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent({
      event_id: `e${String(i).padStart(3, '0')}`,
      timestamp: new Date(NOW.getTime() - (n - i) * 1000).toISOString(),
    }),
  )
}

/**
 * A fake `Client` that actually implements the server's paging semantics
 * (events/routes.ts) rather than replaying a canned response list — the
 * only way to reproduce the burst-loses-events Critical, since a fake that
 * ignores `limit` or always returns whatever fixture it's handed can never
 * produce a genuinely full page. `allEvents` is read fresh on every call,
 * so a test can mutate it between polls to simulate a burst arriving in a
 * `--follow` gap.
 *
 * Cursorless: sorts ascending, takes the newest `limit` — the same
 * "DESC then reverse" shape the real route documents (routes.ts:408,458).
 * Cursored: decodes the JSON-encoded `{ timestamp, eventId }` cursor this
 * fake itself produces and returns the next `limit` strictly after it in
 * ascending (timestamp, event_id) order — keyset semantics, matching
 * `afterClause` in the real route.
 */
function makeRealisticClient(allEvents: FakeEventRecord[]): {
  client: Client
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const sortAsc = (a: FakeEventRecord, b: FakeEventRecord) =>
    a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id)

  const client = {
    get: async (path: string, query: Record<string, string | number | undefined> = {}) => {
      calls.push({ path, query })
      const limit = typeof query.limit === 'number' ? query.limit : 50

      let pool = allEvents
      if (typeof query.since === 'string') {
        const since = query.since
        pool = pool.filter((e) => e.timestamp >= since)
      }
      if (typeof query.until === 'string') {
        const until = query.until
        pool = pool.filter((e) => e.timestamp <= until)
      }

      let rows: FakeEventRecord[]
      if (typeof query.after === 'string') {
        const cursor = JSON.parse(query.after) as { timestamp: string; eventId: string }
        rows = pool
          .filter(
            (e) =>
              e.timestamp > cursor.timestamp ||
              (e.timestamp === cursor.timestamp && e.event_id > cursor.eventId),
          )
          .sort(sortAsc)
          .slice(0, limit)
      } else {
        const sorted = [...pool].sort(sortAsc)
        rows = sorted.slice(Math.max(0, sorted.length - limit))
      }

      const last = rows[rows.length - 1]
      const next_cursor = last
        ? JSON.stringify({ timestamp: last.timestamp, eventId: last.event_id })
        : null
      return { events: rows, next_cursor }
    },
  }
  return { client: client as unknown as Client, calls }
}

describe('runEvents', () => {
  it('resolves --since to an absolute instant before calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--since', '15m'], ctx)
    expect(calls[0]?.query.since).toBe('2026-08-08T11:45:00.000Z')
  })

  it('defaults to the last 15 minutes', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents([], ctx)
    expect(calls[0]?.query.since).toBe('2026-08-08T11:45:00.000Z')
  })

  it('passes --event and --person straight through', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--event', 'signup', '--person', 'user-42'], ctx)
    expect(calls[0]?.query.event).toBe('signup')
    expect(calls[0]?.query.person).toBe('user-42')
  })

  it('follows from the cursor the server returned, never re-fetching', async () => {
    // The property that makes --follow trustworthy: no event twice, none
    // missed. Two polls, the second must carry the first's next_cursor and
    // no `since`. Poll 2 returns a NEW event, not an empty page — an empty
    // second poll proves almost nothing about advancing.
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const page2 = { events: [makeEvent({ event_id: 'e2' })], next_cursor: 'cursor-2' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, page2, EMPTY_PAGE])
    const { ctx, out } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })

    const code = await runEvents(['--follow', '--json'], ctx)

    expect(code).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.query.since).toBe('2026-08-08T11:45:00.000Z')
    expect(calls[0]?.query.after).toBeUndefined()
    expect(calls[1]?.query.after).toBe('cursor-1')
    expect(calls[1]?.query.since).toBeUndefined()

    const ids = out
      .join('')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event_id: string }).event_id)
    expect(ids).toEqual(['e1', 'e2'])
  })

  it('keeps the previous cursor when a poll returns no events', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, EMPTY_PAGE, EMPTY_PAGE])
    const { ctx } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })

    await runEvents(['--follow'], ctx)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.query.after).toBe('cursor-1')
  })

  it('does not advance the cursor from an empty page even if the server sends a truthy next_cursor', async () => {
    // Keyed on events.length, not solely on next_cursor's truthiness — see
    // events.ts's comment on this exact line. Not reachable against
    // today's real server (which never does this), but the "no event
    // twice" guarantee should not rest entirely on that external promise.
    const malformedEmptyPage = { events: [], next_cursor: 'ghost-cursor' }
    const page2 = { events: [makeEvent({ event_id: 'e2' })], next_cursor: 'cursor-2' }
    let sleeps = 0
    const { client, calls } = makeClient([malformedEmptyPage, page2])
    const { ctx } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })

    await runEvents(['--follow'], ctx)

    expect(calls).toHaveLength(2)
    expect(calls[1]?.query.after).toBeUndefined()
    expect(calls[1]?.query.since).toBe('2026-08-08T11:45:00.000Z')
  })

  it('stops following after the injected sleep is cancelled, and surfaces the resume cursor', async () => {
    const page = { events: [makeEvent()], next_cursor: 'cursor-1' }
    const { client, calls } = makeClient([page])
    const { ctx, errOut } = makeCtx(client, {
      sleep: () => Promise.reject(new Error('cancelled')),
    })

    const code = await runEvents(['--follow'], ctx)

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    // This is the case that most wants a resume cursor: a long-running
    // --follow session that got cancelled mid-flight.
    const lines = parseErrLines(errOut)
    expect(lines).toContainEqual({ next_cursor: 'cursor-1' })
  })

  it('polls every 2000ms while following', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const sleepArgs: number[] = []
    const { client } = makeClient([page1, EMPTY_PAGE])
    const { ctx } = makeCtx(client, {
      sleep: (ms) => {
        sleepArgs.push(ms)
        return Promise.reject(new Error('stop'))
      },
    })
    await runEvents(['--follow'], ctx)
    expect(sleepArgs).toEqual([2000])
  })

  it('exits 1 on an ApiError mid-follow (a 503 included), rather than retrying', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const err503 = new ApiError(503, 'draining', 'the server is saturated or shutting down; retry')
    let sleeps = 0
    const { client, calls } = makeClient([page1, err503])
    const { ctx, errOut } = makeCtx(client, {
      sleep: () => {
        sleeps++
        return Promise.resolve()
      },
    })
    const code = await runEvents(['--follow'], ctx)
    expect(code).toBe(1)
    expect(calls).toHaveLength(2)
    expect(sleeps).toBe(1)
    const errLines = parseErrLines(errOut)
    expect(errLines).toContainEqual(
      expect.objectContaining({ code: 'draining' }) as unknown as Record<string, unknown>,
    )
  })

  it('an ApiError whose own code duck-types as EPIPE still exits 1, never a silent 0', async () => {
    // ApiError.code is sourced verbatim from the server's response body
    // (client.ts) — a non-2xx response the server happened to answer with
    // `{"error":"EPIPE"}` must not be mistaken for a closed pipe.
    const err = new ApiError(500, 'EPIPE', 'the request failed with status 500')
    const { client } = makeClient([err])
    const { ctx, out, errOut } = makeCtx(client)
    const code = await runEvents([], ctx)
    expect(code).toBe(1)
    expect(out.join('')).toBe('')
    const errLines = parseErrLines(errOut)
    expect(errLines).toContainEqual(
      expect.objectContaining({ code: 'EPIPE' }) as unknown as Record<string, unknown>,
    )
  })

  it('returns 2 and prints usage on a bad --since, without calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    const code = await runEvents(['--since', 'yesterday'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('returns 1 and writes a json error object when the API rejects the key', async () => {
    const { client } = makeClient([
      new ApiError(401, 'invalid_server_key', 'the server key was rejected'),
    ])
    const { ctx, errOut } = makeCtx(client, { isTty: false })
    const code = await runEvents([], ctx)
    expect(code).toBe(1)
    const parsed = JSON.parse(errOut.join('')) as { error: string; code: string }
    expect(parsed.code).toBe('invalid_server_key')
  })

  it('emits one JSON line per event when not a terminal', async () => {
    const page = {
      events: [makeEvent({ event_id: 'e1' }), makeEvent({ event_id: 'e2' })],
      next_cursor: 'c',
    }
    const { client } = makeClient([page])
    const { ctx, out } = makeCtx(client, { isTty: false })
    await runEvents([], ctx)
    const lines = out.join('').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ event_id: 'e1' })
    expect(JSON.parse(lines[1] as string)).toMatchObject({ event_id: 'e2' })
  })

  it('rejects a non-numeric --limit with a usage error, without calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    const code = await runEvents(['--limit', 'lots'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects a zero or negative --limit', async () => {
    const { client } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    expect(await runEvents(['--limit', '0'], ctx)).toBe(2)
    expect(await runEvents(['--limit', '-5'], ctx)).toBe(2)
  })

  it('rejects a --limit above the server’s own ceiling (500), without calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    const code = await runEvents(['--limit', '501'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).toMatch(/500/)
  })

  it('accepts a --limit exactly at the server’s ceiling (500)', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    const code = await runEvents(['--limit', '500'], ctx)
    expect(code).toBe(0)
    expect(calls[0]?.query.limit).toBe(500)
  })

  it('sends a valid --limit as a number', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--limit', '10'], ctx)
    expect(calls[0]?.query.limit).toBe(10)
  })

  it('sends the CLI default limit (50) even when --limit is not passed', async () => {
    // Always sending an explicit limit is what lets the full-page check
    // tell a genuinely-complete page apart from one that was truncated.
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents([], ctx)
    expect(calls[0]?.query.limit).toBe(EVENTS_DEFAULT_LIMIT)
  })

  it('keeps --limit on every poll of a --follow session, not just the first', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, EMPTY_PAGE])
    const { ctx } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })
    await runEvents(['--follow', '--limit', '5'], ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.query.limit).toBe(5)
    expect(calls[1]?.query.limit).toBe(5)
  })

  it('keeps --event and --person on every poll of a --follow session', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, EMPTY_PAGE])
    const { ctx } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })
    await runEvents(['--follow', '--event', 'signup', '--person', 'user-42'], ctx)
    expect(calls[1]?.query.event).toBe('signup')
    expect(calls[1]?.query.person).toBe('user-42')
  })

  it('carries --until into every poll, cursor or not', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, EMPTY_PAGE])
    const { ctx } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 2) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })
    await runEvents(['--follow', '--until', '2026-08-08T13:00:00.000Z'], ctx)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.query.until).toBe('2026-08-08T13:00:00.000Z')
    expect(calls[1]?.query.until).toBe('2026-08-08T13:00:00.000Z')
    expect(calls[1]?.query.after).toBe('cursor-1')
  })

  it('--after seeds the first poll cursor directly, bypassing --since', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--after', 'resume-cursor'], ctx)
    expect(calls[0]?.query.after).toBe('resume-cursor')
    expect(calls[0]?.query.since).toBeUndefined()
  })

  it('rejects an inverted window (--since after --until) as a usage error, without calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    const code = await runEvents(
      ['--since', '2026-08-08T11:00:00.000Z', '--until', '2026-08-08T10:00:00.000Z'],
      ctx,
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects unexpected positional arguments as a usage error, without calling the API', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    const code = await runEvents(['gimme', 'everything'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('never echoes a positional argument’s value into the usage error — a real regression this shipped once', async () => {
    // `lyraflow events $LYRAFLOW_SERVER_KEY` (forgetting the flag name)
    // makes the key itself a positional. An earlier version of this
    // message interpolated the positional's VALUE straight into the
    // error, which would put a secret in stdout/stderr, shell history,
    // CI logs, and this CLI's own transcript.
    const secretLookingValue = 'sk_live_TOPSECRET_abc123'
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    const code = await runEvents([secretLookingValue], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(secretLookingValue)
    // Still says SOMETHING useful — count and rough location, not silence.
    expect(errOut.join('')).toMatch(/1 unexpected/)
  })

  it('never echoes a positional value reachable past a `--` terminator either', async () => {
    // The second exploit shape the review named:
    // `events --host H --server-key sk_real -- --server-key sk_live_...`
    // — everything after `--` is positional, including a token that LOOKS
    // like a flag.
    const secretLookingValue = 'sk_live_TOPSECRET_abc123'
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    const code = await runEvents(
      ['--host', 'H', '--server-key', 'sk_real', '--', '--server-key', secretLookingValue],
      ctx,
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(secretLookingValue)
    expect(errOut.join('')).toMatch(/2 unexpected/)
  })

  it('still gives a specific, useful diagnostic for an ordinary typo — redacting the value must not swallow the location too', async () => {
    // Deliberately NOT --follow here: if a future mutation removed the
    // positionals check entirely, --follow would fall through into an
    // unbounded follow loop against the default (never-cancelling) sleep
    // and hang/OOM the test runner instead of failing cleanly. --event
    // exercises the identical "after a real flag" code path with no such
    // risk.
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    const code = await runEvents(['--event', 'signup', 'oops'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    const parsed = JSON.parse(errOut.join('')) as { error: string }
    expect(parsed.error).toBe('1 unexpected positional argument after --event')
  })

  it('never echoes a flag’s value when the positional follows a --flag=value token — the leak round 3 found', async () => {
    // Round 2's fix stopped echoing the positional's OWN value, but built
    // the location by reading the raw argv token immediately before it —
    // and for `--flag=value` syntax, that token IS the value.
    // `--server-key=sk_live_...` is one token; "the token before the
    // positional" is that whole thing.
    const secretLookingValue = 'sk_live_TOPSECRET_abc123'
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    const code = await runEvents([`--server-key=${secretLookingValue}`, 'foo'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(secretLookingValue)
    const parsed = JSON.parse(errOut.join('')) as { error: string }
    expect(parsed.error).toBe('1 unexpected positional argument after --server-key')
  })

  it('never leaks a sentinel secret placed in ANY argv slot — positional, --flag=value, a flag’s separate value, past --, first, or last', async () => {
    // The generalised invariant round 2's and round 3's individually-named
    // exploit tests are each one example of. A sentinel placed in any one
    // of these ten slots must never appear anywhere in stdout or stderr,
    // on any code path (usage error, --json parse-failure error, or a
    // clean run). `--event`'s own value is never echoed anywhere (it only
    // ever reaches the outgoing HTTP query, never CLI text output), so
    // using it as a carrier for the "flag's own value" shapes below is
    // safe and does not depend on --event never being validated — unlike
    // --since/--until/--limit, whose validators legitimately echo back
    // what they were given for a non-secret typo, which is expected
    // behaviour this sweep is not testing.
    const secret = 'sk_live_SENTINEL_never_here'
    const shapes: string[][] = [
      [secret], // bare positional, first
      ['--event', 'signup', secret], // positional after a flag+value
      [secret, '--event', 'signup'], // positional, then more flags after
      [`--server-key=${secret}`, 'foo'], // --flag=value, value is the secret
      [`--event=${secret}`], // --flag=value with no trailing positional
      ['--server-key', secret, 'foo'], // flag's own separate value, then a positional
      ['--host', 'H', '--', secret], // past a -- terminator
      ['--host', 'H', '--', '--server-key', secret], // past --, flag-shaped positional + value
      ['--event', 'signup', 'a', secret], // not first, not last
      [secret, secret], // repeated
    ]

    for (const argv of shapes) {
      const { client } = makeClient([EMPTY_PAGE])
      const { ctx, out, errOut } = makeCtx(client)
      await runEvents(argv, ctx)
      expect(out.join('')).not.toContain(secret)
      expect(errOut.join('')).not.toContain(secret)
    }
  })

  it('honours a --json that did parse when an unrelated flag fails to, rather than defaulting from isTty', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client, { isTty: true })
    const code = await runEvents(['--json', '--this-flag-does-not-exist'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    // Human mode would not be valid JSON; this must parse.
    expect(() => JSON.parse(errOut.join(''))).not.toThrow()
  })

  it('surfaces next_cursor as a real JSON object on stderr after a non-follow run, so it can be fed back via --after', async () => {
    const page = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page])
    const { ctx, errOut } = makeCtx(client)
    await runEvents([], ctx)
    expect(parseErrLines(errOut)).toContainEqual({ next_cursor: 'cursor-1' })
  })

  it('renders next_cursor as a readable human line too, in human mode', async () => {
    const page = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page])
    const { ctx, errOut } = makeCtx(client, { isTty: true })
    await runEvents([], ctx)
    expect(errOut.join('')).toContain('next_cursor: cursor-1')
  })

  it('does not surface next_cursor on stderr on an ordinary poll boundary — only on cancellation or a non-follow run', async () => {
    // Two full, successful polls (both sleeps resolve), THEN a cancelled
    // third sleep. Exactly one next_cursor line should appear in total —
    // the one from cancellation — not one per ordinary poll boundary too.
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const page2 = { events: [makeEvent({ event_id: 'e2' })], next_cursor: 'cursor-2' }
    let sleeps = 0
    const { client, calls } = makeClient([page1, page2, EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client, {
      sleep: () => {
        sleeps++
        if (sleeps >= 3) return Promise.reject(new Error('stop'))
        return Promise.resolve()
      },
    })
    await runEvents(['--follow'], ctx)
    expect(calls).toHaveLength(3)
    const cursorLines = parseErrLines(errOut).filter((l) => 'next_cursor' in l)
    expect(cursorLines).toHaveLength(1)
    expect(cursorLines[0]).toEqual({ next_cursor: 'cursor-2' })
  })

  it('never leaks the sleep/client wiring into the emitted error on a usage failure', async () => {
    const { client } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    await runEvents(['--since', 'not-a-date'], ctx)
    expect(errOut.join('')).not.toMatch(/sleep|client/i)
  })

  it('treats a write EPIPE (a closed pipe, e.g. `| head`) as a clean stop, not a crash — exit 0', async () => {
    const page = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page])
    const { ctx } = makeCtx(client, {
      write: () => {
        throw epipe()
      },
    })
    await expect(runEvents([], ctx)).resolves.toBe(0)
  })

  it('a write error that is not EPIPE still propagates rather than being swallowed', async () => {
    const page = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page])
    const boom = new Error('disk full')
    const { ctx } = makeCtx(client, {
      write: () => {
        throw boom
      },
    })
    await expect(runEvents([], ctx)).rejects.toBe(boom)
  })

  describe('the burst-larger-than-one-page Critical', () => {
    it('warns on stderr (as real JSON), naming the oldest event shown, when a cursorless first poll comes back exactly full', async () => {
      const events = makeBurst(120)
      const { client, calls } = makeRealisticClient(events)
      const { ctx, out, errOut } = makeCtx(client)

      const code = await runEvents([], ctx)

      expect(code).toBe(0)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.query.limit).toBe(50)

      const lines = out.join('').trim().split('\n')
      expect(lines).toHaveLength(50)
      const shown = lines.map((l) => JSON.parse(l) as FakeEventRecord)
      // The oldest of the 50 shown is the 71st event overall (index 70) —
      // 70 older events exist in the window and were never displayed.
      expect(shown[0]?.event_id).toBe('e070')

      const errLines = parseErrLines(errOut)
      const warningLine = errLines.find((l) => 'warning' in l) as { warning: string } | undefined
      expect(warningLine).toBeDefined()
      expect(warningLine?.warning).toMatch(/--limit 50/)
      expect(warningLine?.warning).toContain(shown[0]?.timestamp as string)
      // The advice must name --until, not --since — see the "advice is
      // followable" test below for proof this direction actually works.
      expect(warningLine?.warning).toMatch(/--until/)
    })

    it('warns again on a full page after an earlier empty poll — not only on the very first poll', async () => {
      const events: FakeEventRecord[] = []
      const { client, calls } = makeRealisticClient(events)
      let sleeps = 0
      const { ctx, errOut } = makeCtx(client, {
        sleep: () => {
          sleeps++
          if (sleeps === 1) events.push(...makeBurst(120))
          if (sleeps >= 2) return Promise.reject(new Error('stop'))
          return Promise.resolve()
        },
      })

      await runEvents(['--follow'], ctx)

      expect(calls).toHaveLength(2)
      // Poll 1 found nothing, so no cursor was ever established — poll 2 is
      // ALSO cursorless, which is exactly the "mid-session" shape.
      expect(calls[1]?.query.after).toBeUndefined()
      expect(calls[1]?.query.since).toBe('2026-08-08T11:45:00.000Z')

      const errLines = parseErrLines(errOut)
      const warningLines = errLines.filter((l) => 'warning' in l) as { warning: string }[]
      expect(warningLines).toHaveLength(1)
      expect(warningLines[0]?.warning).toMatch(/--limit 50/)
    })

    it('does not warn when a page comes back under the limit — there is nothing hidden', async () => {
      const events = makeBurst(10)
      const { client } = makeRealisticClient(events)
      const { ctx, errOut } = makeCtx(client)
      await runEvents([], ctx)
      const errLines = parseErrLines(errOut)
      expect(errLines.some((l) => 'warning' in l)).toBe(false)
    })

    it('does not warn once a cursor already exists, even when a full page arrives — draining a backlog is normal, not the Critical', async () => {
      // A cursor already seeded via --after: every poll below is
      // cursor-based from the start, so a full page just means "more to
      // drain next poll", never "events silently lost".
      const events = makeBurst(120)
      const { client, calls } = makeRealisticClient(events)
      const firstCursor = JSON.stringify({
        timestamp: new Date(NOW.getTime() - 120 * 1000 - 1).toISOString(),
        eventId: 'e-before-everything',
      })
      let sleeps = 0
      const { ctx, errOut } = makeCtx(client, {
        sleep: () => {
          sleeps++
          if (sleeps >= 2) return Promise.reject(new Error('stop'))
          return Promise.resolve()
        },
      })
      const code = await runEvents(['--after', firstCursor, '--follow', '--limit', '50'], ctx)
      expect(code).toBe(0)
      expect(calls).toHaveLength(2)
      expect(calls[0]?.query.after).toBe(firstCursor)
      expect(calls[1]?.query.after).not.toBe(firstCursor)
      const errLines = parseErrLines(errOut)
      expect(errLines.some((l) => 'warning' in l)).toBe(false)
    })

    it('does not warn on a full page once a cursor was established normally through --follow (not only via --after)', async () => {
      // Pins the false-positive guard for the shape a real session
      // actually takes: the cursor comes from the SERVER's own
      // next_cursor on an earlier poll, never from --after. Mutating the
      // "hadCursor" check to key off `flags.after` instead of the real
      // cursor variable would pass every OTHER test in this file (none of
      // them establish a cursor this way and then hit a full page) but
      // fail this one.
      const page1 = { events: [makeEvent({ event_id: 'seed' })], next_cursor: 'cursor-seed' }
      const fullPage = { events: makeBurst(EVENTS_DEFAULT_LIMIT), next_cursor: 'cursor-full' }
      let sleeps = 0
      const { client, calls } = makeClient([page1, fullPage])
      const { ctx, errOut } = makeCtx(client, {
        sleep: () => {
          sleeps++
          if (sleeps >= 2) return Promise.reject(new Error('stop'))
          return Promise.resolve()
        },
      })
      await runEvents(['--follow'], ctx)
      expect(calls).toHaveLength(2)
      expect(calls[1]?.query.after).toBe('cursor-seed')
      const errLines = parseErrLines(errOut)
      expect(errLines.some((l) => 'warning' in l)).toBe(false)
    })

    it("the warning's advice is followable — rerunning with the same --since and the named --until actually reveals the hidden older events", async () => {
      const events = makeBurst(120)
      const { client } = makeRealisticClient(events)

      const { ctx: ctx1, out: out1, errOut: errOut1 } = makeCtx(client)
      await runEvents([], ctx1)
      const shown1 = out1
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as FakeEventRecord)
      const warning1 = parseErrLines(errOut1).find((l) => 'warning' in l) as
        | { warning: string }
        | undefined
      const namedTimestamp = /events older than (\S+) in this window/.exec(
        warning1?.warning ?? '',
      )?.[1]
      expect(namedTimestamp).toBe(shown1[0]?.timestamp)

      // Follow the advice literally: same (default) --since, --until set
      // to the named timestamp.
      const { ctx: ctx2, out: out2 } = makeCtx(client)
      await runEvents(['--until', namedTimestamp as string], ctx2)
      const shown2 = out2
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as FakeEventRecord)

      expect(shown2.length).toBeGreaterThan(0)
      // Reveals events strictly older than anything call 1 showed.
      expect(shown2[0]?.event_id).toBe('e021')
      expect((shown2[0]?.timestamp as string) < (shown1[0]?.timestamp as string)).toBe(true)

      // Contrast with the OLD (wrong) advice direction: widening --since
      // further back changes nothing, since a cursorless request always
      // answers with the newest `limit` regardless of how far `since`
      // reaches — proving that direction would NOT have helped.
      const { ctx: ctx3, out: out3 } = makeCtx(client)
      await runEvents(['--since', '1h'], ctx3)
      const shown3 = out3
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as FakeEventRecord)
      expect(shown3[0]?.event_id).toBe(shown1[0]?.event_id)
    })
  })

  describe('EVENTS_MAX_LIMIT / EVENTS_DEFAULT_LIMIT', () => {
    it('matches the server’s own EVENTS_MAX_LIMIT, so the two cannot silently drift', () => {
      // Same technique output.ts's CLI_VERSION pin test uses against
      // package.json: read the independent source of truth off disk
      // rather than trust a hand-copy to stay in sync by discipline.
      // packages/cli has no dependency on packages/server (by design —
      // this CLI only ever talks to it over HTTP), so this reads the
      // source file directly instead of importing the constant.
      const routesSrc = readFileSync(
        join(import.meta.dirname, '..', '..', '..', '..', 'server', 'src', 'events', 'routes.ts'),
        'utf8',
      )
      const maxMatch = /export const EVENTS_MAX_LIMIT = (\d+)/.exec(routesSrc)
      expect(maxMatch).not.toBeNull()
      expect(Number(maxMatch?.[1])).toBe(EVENTS_MAX_LIMIT)

      const defaultMatch =
        /limit:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.max\(EVENTS_MAX_LIMIT\)\.default\((\d+)\)/.exec(
          routesSrc,
        )
      expect(defaultMatch).not.toBeNull()
      expect(Number(defaultMatch?.[1])).toBe(EVENTS_DEFAULT_LIMIT)
    })
  })
})
