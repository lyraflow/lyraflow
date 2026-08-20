import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { runUsage } from './usage.js'

const NOW = new Date('2026-08-19T12:00:00.000Z')

const RECORD = {
  month: '2026-08',
  events_accepted: 412_000,
  events_rejected: 12,
  events_throttled: 0,
  events_bot: 9_310,
  monthly_event_quota: 1_000_000,
}

function makeClient(get: unknown | Error): { client: Client; paths: string[] } {
  const paths: string[] = []
  const client = {
    get: async (path: string) => {
      paths.push(path)
      if (get instanceof Error) throw get
      return get
    },
    post: async () => {
      throw new Error('usage never posts')
    },
  } as unknown as Client
  return { client, paths }
}

function makeCtx(client: Client, overrides: Partial<CommandContext> = {}) {
  const out: string[] = []
  const errOut: string[] = []
  return {
    ctx: {
      client,
      isTty: false,
      stdinIsTty: false,
      write: (s: string) => out.push(s),
      writeErr: (s: string) => errOut.push(s),
      now: () => NOW,
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('usage never prompts')),
      ...overrides,
    } as CommandContext,
    out,
    errOut,
  }
}

describe('runUsage', () => {
  it('reads the usage endpoint rather than the database', async () => {
    const { client, paths } = makeClient(RECORD)
    const { ctx } = makeCtx(client)
    expect(await runUsage(['--json'], ctx)).toBe(0)
    expect(paths).toEqual(['/v1/project/usage'])
  })

  // `--json` is the stable interface, so it must be the server's record and
  // nothing else. A percentage computed here would be a field no server ever
  // sent, which an agent could come to depend on.
  it('emits the server record verbatim under --json, adding no computed field', async () => {
    const { client } = makeClient(RECORD)
    const { ctx, out } = makeCtx(client)
    await runUsage(['--json'], ctx)
    expect(JSON.parse(out.join(''))).toEqual(RECORD)
  })

  it('shows the quota, the percentage and the bot count in the human view', async () => {
    const { client } = makeClient(RECORD)
    const { ctx, out } = makeCtx(client, { isTty: true })
    await runUsage([], ctx)
    const text = out.join('')
    expect(text).toContain('412,000')
    expect(text).toContain('1,000,000')
    expect(text).toContain('41.2%')
    expect(text).toContain('9,310')
  })

  // An unlimited quota is `null`, not 0 -- dividing by it would print
  // `Infinity%`, and printing `0` would read as "no quota left".
  it('says unlimited rather than dividing by a null quota', async () => {
    const { client } = makeClient({ ...RECORD, monthly_event_quota: null })
    const { ctx, out } = makeCtx(client, { isTty: true })
    await runUsage([], ctx)
    const text = out.join('')
    expect(text).toContain('unlimited')
    expect(text).not.toContain('Infinity')
    expect(text).not.toContain('NaN')
  })

  // The figure is persisted and the counters flush every ~10s, so it can lag
  // ingest. A number that silently lags is worse than one labelled as lagging.
  it('says the figure can lag', async () => {
    const { client } = makeClient(RECORD)
    const { ctx, out } = makeCtx(client, { isTty: true })
    await runUsage([], ctx)
    expect(out.join('')).toMatch(/lag/i)
  })

  it('reports a server failure rather than throwing', async () => {
    const { client } = makeClient(new ApiError(401, 'invalid_server_key', 'nope'))
    const { ctx, errOut } = makeCtx(client)
    expect(await runUsage(['--json'], ctx)).not.toBe(0)
    expect(errOut.join('')).toContain('invalid_server_key')
  })

  it('refuses a stray positional', async () => {
    const { client } = makeClient(RECORD)
    const { ctx } = makeCtx(client)
    expect(await runUsage(['whoops'], ctx)).not.toBe(0)
  })
})
