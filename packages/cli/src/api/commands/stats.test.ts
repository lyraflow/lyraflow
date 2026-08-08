import { describe, expect, it } from 'vitest'
import type { CommandContext } from '../../index.js'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import { runStats } from './stats.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')

interface FakeCall {
  path: string
  query: Record<string, string | number | undefined>
}

function makeClient(response: unknown): { client: Client; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client = {
    get: async (path: string, query: Record<string, string | number | undefined> = {}) => {
      calls.push({ path, query })
      if (response instanceof Error) throw response
      return response
    },
  }
  return { client: client as unknown as Client, calls }
}

function makeCtx(client: Client): { ctx: CommandContext; out: string[]; errOut: string[] } {
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
    },
    out,
    errOut,
  }
}

describe('runStats', () => {
  it('defaults to the last 24 hours at 1h buckets', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats([], ctx)
    expect(calls[0]?.query.interval).toBe('1h')
    expect(calls[0]?.query.since).toBe('2026-08-07T12:00:00.000Z')
    expect(calls[0]?.query.group_by).toBeUndefined()
  })

  it('sends group_by=event_name for --by-event', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--by-event'], ctx)
    expect(calls[0]?.query.group_by).toBe('event_name')
  })

  it('emits one flat row per bucket and name, not a nested object', async () => {
    const response = {
      buckets: [
        { bucket: '2026-08-08T10:00:00.000Z', event_name: 'signup', events: 3 },
        { bucket: '2026-08-08T10:00:00.000Z', event_name: 'page_view', events: 40 },
        { bucket: '2026-08-08T11:00:00.000Z', event_name: 'signup', events: 1 },
      ],
    }
    const { client } = makeClient(response)
    const { ctx, out } = makeCtx(client)
    await runStats(['--by-event'], ctx)
    const lines = out.join('').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] as string)).toEqual(response.buckets[0])
    expect(JSON.parse(lines[1] as string)).toEqual(response.buckets[1])
    expect(JSON.parse(lines[2] as string)).toEqual(response.buckets[2])
  })

  it('resolves --since to an absolute instant before calling the API', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--since', '2h'], ctx)
    expect(calls[0]?.query.since).toBe('2026-08-08T10:00:00.000Z')
  })

  it('does not apply the flat 24h default at a non-1h interval, leaving `since` for the server to default', async () => {
    // A flat 24h default at 1m resolution would be 1440 buckets, above the
    // server's own STATS_MAX_BUCKETS (1000) — see stats.ts's defaultSince
    // docstring. Confirms the CLI does not walk into that on the bare
    // "is this working" call.
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--interval', '1m'], ctx)
    expect(calls[0]?.query.since).toBeUndefined()
    expect(calls[0]?.query.interval).toBe('1m')
  })

  it('rejects an invalid --interval with a usage error, without calling the API', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    const code = await runStats(['--interval', '5m'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('returns 2 and prints usage on a bad --since, without calling the API', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    const code = await runStats(['--since', 'yesterday'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('returns 1 and writes a json error object when the API rejects the key', async () => {
    const { client } = makeClient(
      new ApiError(401, 'invalid_server_key', 'the server key was rejected'),
    )
    const { ctx, errOut } = makeCtx(client)
    const code = await runStats([], ctx)
    expect(code).toBe(1)
    const parsed = JSON.parse(errOut.join('')) as { error: string; code: string }
    expect(parsed.code).toBe('invalid_server_key')
  })

  it('an explicit --since is honoured even at a non-1h interval', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--interval', '1m', '--since', '30m'], ctx)
    expect(calls[0]?.query.since).toBe('2026-08-08T11:30:00.000Z')
  })
})
