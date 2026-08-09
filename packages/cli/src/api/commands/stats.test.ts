import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { DEFAULT_WINDOW_MS, runStats } from './stats.js'

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
      prompt: () => Promise.reject(new Error('runStats should never prompt')),
      ...overrides,
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

  it('rejects an inverted window (--since after --until) as a usage error, without calling the API', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    const code = await runStats(
      ['--since', '2026-08-08T11:00:00.000Z', '--until', '2026-08-08T10:00:00.000Z'],
      ctx,
    )
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects unexpected positional arguments as a usage error, without calling the API', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    const code = await runStats(['gimme', 'everything'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('never echoes a positional argument’s value into the usage error — a real regression this shipped once', async () => {
    const secretLookingValue = 'sk_live_TOPSECRET_abc123'
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx, errOut } = makeCtx(client)
    const code = await runStats([secretLookingValue], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(secretLookingValue)
    expect(errOut.join('')).toMatch(/1 unexpected/)
  })

  it('never echoes a flag’s value when the positional follows a --flag=value token — the leak round 3 found', async () => {
    const secretLookingValue = 'sk_live_TOPSECRET_abc123'
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx, errOut } = makeCtx(client)
    const code = await runStats([`--server-key=${secretLookingValue}`, 'foo'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(secretLookingValue)
    const parsed = JSON.parse(errOut.join('')) as { error: string }
    expect(parsed.error).toBe('1 unexpected positional argument after --server-key')
  })

  it('never leaks a sentinel secret placed in ANY argv slot — positional, --flag=value, a flag’s separate value, past --, first, or last', async () => {
    // Deliberately never puts the secret as --interval's (or --since's)
    // OWN value with nothing else: those flags' validators legitimately
    // echo back what they were given (e.g. parseInterval's "got \"...\""),
    // which is expected, useful behaviour for a non-secret flag — not the
    // positional-redaction leak this test exists to sweep for. Every
    // shape here keeps the secret in a slot that can ONLY ever be reached
    // through positional handling: a bare positional, or a flag whose own
    // value is never echoed anywhere by design (--host/--server-key).
    const secret = 'sk_live_SENTINEL_never_here'
    const shapes: string[][] = [
      [secret],
      ['--interval', '1h', secret],
      [secret, '--interval', '1h'],
      [`--server-key=${secret}`, 'foo'],
      [`--host=${secret}`],
      ['--server-key', secret, 'foo'],
      ['--host', 'H', '--', secret],
      ['--host', 'H', '--', '--server-key', secret],
      ['--interval', '1h', 'a', secret],
      [secret, secret],
    ]

    for (const argv of shapes) {
      const { client } = makeClient({ buckets: [] })
      const { ctx, out, errOut } = makeCtx(client)
      await runStats(argv, ctx)
      expect(out.join('')).not.toContain(secret)
      expect(errOut.join('')).not.toContain(secret)
    }
  })

  it('anchors --since to a given --until (not to a real "now") when --since is omitted, at a non-default interval', async () => {
    // The exact hole this closes: at any interval other than 1h, since was
    // previously left unsent whenever --since was omitted, regardless of
    // whether --until was given — so the server computed its OWN default
    // since relative to its own current now(), completely ignoring a
    // caller-supplied, possibly-past --until. That silently and
    // structurally defeated the inverted-window guard below, since an
    // unsent `since` can never be "after" anything.
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--interval', '1m', '--until', '2026-08-01T00:00:00.000Z'], ctx)
    expect(calls[0]?.query.until).toBe('2026-08-01T00:00:00.000Z')
    // STATS_DEFAULT_WINDOW_MS['1m'] (events/routes.ts) is 1 hour.
    expect(calls[0]?.query.since).toBe('2026-07-31T23:00:00.000Z')
  })

  it('anchors --since to a given --until at the default (1h) interval too, not only the non-default ones', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    await runStats(['--until', '2026-08-01T00:00:00.000Z'], ctx)
    expect(calls[0]?.query.until).toBe('2026-08-01T00:00:00.000Z')
    expect(calls[0]?.query.since).toBe('2026-07-31T00:00:00.000Z')
  })

  it('the default --since is structurally never after a given --until, at any interval — the case that used to slip past the inverted-window guard', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx } = makeCtx(client)
    const code = await runStats(['--interval', '1m', '--until', '2020-01-01T00:00:00.000Z'], ctx)
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    const since = new Date(calls[0]?.query.since as string).getTime()
    const until = new Date(calls[0]?.query.until as string).getTime()
    expect(since).toBeLessThanOrEqual(until)
  })

  it('an ApiError whose own code duck-types as EPIPE still exits 1, never a silent 0', async () => {
    const err = new ApiError(500, 'EPIPE', 'the request failed with status 500')
    const { client } = makeClient(err)
    const { ctx, out, errOut } = makeCtx(client)
    const code = await runStats([], ctx)
    expect(code).toBe(1)
    expect(out.join('')).toBe('')
    const parsed = JSON.parse(errOut.join('')) as { code: string }
    expect(parsed.code).toBe('EPIPE')
  })

  it('honours a --json that did parse when an unrelated flag fails to, rather than defaulting from isTty', async () => {
    const { client, calls } = makeClient({ buckets: [] })
    const { ctx, errOut } = makeCtx(client, { isTty: true })
    const code = await runStats(['--json', '--this-flag-does-not-exist'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(() => JSON.parse(errOut.join(''))).not.toThrow()
  })

  it('treats a write EPIPE (a closed pipe, e.g. `| head`) as a clean stop, not a crash — exit 0', async () => {
    const response = { buckets: [{ bucket: '2026-08-08T10:00:00.000Z', events: 3 }] }
    const { client } = makeClient(response)
    const { ctx } = makeCtx(client, {
      write: () => {
        throw epipe()
      },
    })
    await expect(runStats([], ctx)).resolves.toBe(0)
  })

  it('a write error that is not EPIPE still propagates rather than being swallowed', async () => {
    const response = { buckets: [{ bucket: '2026-08-08T10:00:00.000Z', events: 3 }] }
    const { client } = makeClient(response)
    const boom = new Error('disk full')
    const { ctx } = makeCtx(client, {
      write: () => {
        throw boom
      },
    })
    await expect(runStats([], ctx)).rejects.toBe(boom)
  })

  describe('DEFAULT_WINDOW_MS', () => {
    it('matches the server’s own STATS_DEFAULT_WINDOW_MS, so the two cannot silently drift', () => {
      // Same technique events.test.ts's EVENTS_MAX_LIMIT/EVENTS_DEFAULT_LIMIT
      // pin test uses (itself the same technique output.ts's CLI_VERSION
      // test uses against package.json): read the independent source of
      // truth off disk rather than trust a hand-copy to stay in sync by
      // discipline. packages/cli has no dependency on packages/server, so
      // this reads the source file directly instead of importing the
      // constant.
      const routesSrc = readFileSync(
        join(import.meta.dirname, '..', '..', '..', '..', 'server', 'src', 'events', 'routes.ts'),
        'utf8',
      )
      const block =
        /export const STATS_DEFAULT_WINDOW_MS: Record<keyof typeof STATS_INTERVALS, number> = \{([\s\S]*?)\}/.exec(
          routesSrc,
        )?.[1]
      expect(block).toBeDefined()

      const evalProduct = (expr: string): number =>
        expr
          .split('*')
          .map((factor) => Number(factor.trim().replace(/_/g, '')))
          .reduce((a, b) => a * b, 1)

      for (const interval of ['1m', '1h', '1d'] as const) {
        const match = new RegExp(`'${interval}':\\s*([^,]+),`).exec(block as string)
        expect(match).not.toBeNull()
        expect(evalProduct(match?.[1] as string)).toBe(DEFAULT_WINDOW_MS[interval])
      }
    })
  })
})
