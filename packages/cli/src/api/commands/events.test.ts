import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { runEvents } from './events.js'

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
 * (`| head`) looks like — see client.ts's `#request` catch comment for the
 * analogous "never assume a caught value's shape" reasoning; here we
 * construct the specific shape Node actually throws. */
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
      ...overrides,
    },
    out,
    errOut,
  }
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

  it('stops following after the injected sleep is cancelled', async () => {
    const page = { events: [makeEvent()], next_cursor: 'cursor-1' }
    const { client, calls } = makeClient([page])
    const { ctx } = makeCtx(client, {
      sleep: () => Promise.reject(new Error('cancelled')),
    })

    const code = await runEvents(['--follow'], ctx)

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
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
    expect(JSON.parse(errOut.join('')) as { code: string }).toMatchObject({ code: 'draining' })
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
    expect(calls[0]?.query.limit).toBe(50)
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

  it('honours a --json that did parse when an unrelated flag fails to, rather than defaulting from isTty', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client, { isTty: true })
    const code = await runEvents(['--json', '--this-flag-does-not-exist'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    // Human mode would not be valid JSON; this must parse.
    expect(() => JSON.parse(errOut.join(''))).not.toThrow()
  })

  it('surfaces next_cursor on stderr after a non-follow run, so it can be fed back via --after', async () => {
    const page = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page])
    const { ctx, errOut } = makeCtx(client)
    await runEvents([], ctx)
    expect(errOut.join('')).toContain('next_cursor: cursor-1')
  })

  it('does not surface next_cursor on stderr while --follow is running (only on a non-follow run)', async () => {
    const page1 = { events: [makeEvent({ event_id: 'e1' })], next_cursor: 'cursor-1' }
    const { client } = makeClient([page1])
    const { ctx, errOut } = makeCtx(client, {
      sleep: () => Promise.reject(new Error('stop')),
    })
    await runEvents(['--follow'], ctx)
    expect(errOut.join('')).not.toContain('next_cursor:')
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
    it('warns on stderr, naming the oldest event shown, when a cursorless first poll comes back exactly full', async () => {
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

      const warning = errOut.join('')
      expect(warning).toMatch(/warning:.*--limit 50/)
      expect(warning).toContain(shown[0]?.timestamp as string)
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

      const warnings = errOut
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('warning:'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/--limit 50/)
    })

    it('does not warn when a page comes back under the limit — there is nothing hidden', async () => {
      const events = makeBurst(10)
      const { client } = makeRealisticClient(events)
      const { ctx, errOut } = makeCtx(client)
      await runEvents([], ctx)
      expect(errOut.join('')).not.toMatch(/warning:/)
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
      expect(errOut.join('')).not.toMatch(/warning:/)
    })
  })
})
