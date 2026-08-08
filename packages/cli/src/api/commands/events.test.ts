import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../../index.js'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
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

function makeEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

  it('sends a valid --limit as a number', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--limit', '10'], ctx)
    expect(calls[0]?.query.limit).toBe(10)
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
    await runEvents(['--follow', '--event', 'signup'], ctx)
    expect(calls[1]?.query.event).toBe('signup')
  })

  it('--after seeds the first poll cursor directly, bypassing --since', async () => {
    const { client, calls } = makeClient([EMPTY_PAGE])
    const { ctx } = makeCtx(client)
    await runEvents(['--after', 'resume-cursor'], ctx)
    expect(calls[0]?.query.after).toBe('resume-cursor')
    expect(calls[0]?.query.since).toBeUndefined()
  })

  it('never leaks the sleep/client wiring into the emitted error on a usage failure', async () => {
    const { client } = makeClient([EMPTY_PAGE])
    const { ctx, errOut } = makeCtx(client)
    await runEvents(['--since', 'not-a-date'], ctx)
    expect(errOut.join('')).not.toMatch(/sleep|client/i)
  })
})
