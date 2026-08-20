import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import type { CommandContext } from '../context.js'
import { runFunnels } from './funnels.js'

const NOW = new Date('2026-08-14T12:00:00.000Z')

interface FakeCall {
  method: 'get' | 'post'
  path: string
  arg?: unknown
}

function makeClient(opts: { get?: unknown; post?: unknown }): {
  client: Client
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const client = {
    get: async (path: string, query: Record<string, unknown> = {}) => {
      calls.push({ method: 'get', path, arg: query })
      if (opts.get instanceof Error) throw opts.get
      return opts.get
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, arg: body })
      if (opts.post instanceof Error) throw opts.post
      return opts.post
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
      stdinIsTty: false,
      write: (s) => out.push(s),
      writeErr: (s) => errOut.push(s),
      now: () => NOW,
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('this command never prompts')),
    } as CommandContext,
    out,
    errOut,
  }
}

const LIST = {
  funnels: [
    {
      id: 3,
      name: 'signup',
      window_seconds: 604800,
      segment_id: null,
      stale: false,
      steps: [{ event: 'landed' }, { event: 'signed_up' }],
      last_entered: 100,
      last_converted: 12,
      last_evaluated_at: '2026-08-14T09:00:00.000Z',
    },
  ],
}

const RUN = {
  entered: 100,
  converted: 12,
  conversion_rate: 0.12,
  steps: [
    { index: 1, event: 'landed', people: 100, from_previous: 1, from_start: 1 },
    { index: 2, event: 'signed_up', people: 12, from_previous: 0.12, from_start: 0.12 },
  ],
  partial_window_entrants: 4,
  range: { since: '2026-08-07T12:00:00.000Z', until: '2026-08-14T12:00:00.000Z' },
  as_of: '2026-08-14T12:00:00.000Z',
  warnings: [{ path: 'range', reason: '4 of the people who entered did so too recently' }],
}

describe('runFunnels', () => {
  it('lists funnels', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx, out } = makeCtx(client)
    expect(await runFunnels(['list'], ctx)).toBe(0)
    expect(out.join('')).toContain('signup')
  })

  it('renders the last run WITH its timestamp, never as a bare number', async () => {
    // The stored count is a cache, not a fact.
    const { client } = makeClient({ get: LIST })
    const { ctx, out } = makeCtx(client)
    await runFunnels(['list', '--human'], ctx)
    expect(out.join('')).toContain('2026-08-14T09:00:00.000Z')
  })

  it('says "stale" rather than "0 steps" for a row that would not parse', async () => {
    const stale = { funnels: [{ ...LIST.funnels[0], steps: null, stale: true }] }
    const { client } = makeClient({ get: stale })
    const { ctx, out } = makeCtx(client)
    await runFunnels(['list', '--human'], ctx)
    expect(out.join('')).toContain('stale')
  })

  it('runs a funnel BY NAME, resolving the id first', async () => {
    const { client, calls } = makeClient({ get: LIST, post: RUN })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['run', 'signup'], ctx)).toBe(0)
    expect(calls[0]).toMatchObject({ method: 'get', path: '/v1/funnels' })
    expect(calls[1]).toMatchObject({ method: 'post', path: '/v1/funnels/3/run' })
  })

  it('sends warnings to stderr and the step table to stdout', async () => {
    // A caveat that corrupts a JSON pipeline is worse than no caveat; one only
    // present in the JSON is one a human reading the table never sees.
    const { client } = makeClient({ get: LIST, post: RUN })
    const { ctx, out, errOut } = makeCtx(client)
    await runFunnels(['run', 'signup', '--json'], ctx)
    const stdout = out.join('')
    expect(stdout).toContain('"index":1')
    expect(stdout).not.toContain('warning')
    expect(errOut.join('')).toContain('warning: range:')
  })

  it('survives a server that sends no `warnings` at all (#107)', async () => {
    // The CLI casts responses rather than validating them, so every required
    // field on its response interfaces is a promise the WIRE makes. `warnings`
    // was added after these routes shipped, so a CLI newer than its server --
    // the normal state of a self-hosted install, where the CLI comes from npm
    // and the server from a compose file -- receives a body without it.
    //
    // Before #107 that was a TypeError from `for...of undefined`: the funnel
    // ran, the server answered, and the operator saw a stack trace instead of
    // their step table.
    const { warnings: _dropped, ...noWarnings } = RUN
    expect('warnings' in noWarnings, 'the fixture must actually omit it').toBe(false)

    const { client } = makeClient({ get: LIST, post: noWarnings })
    const { ctx, out, errOut } = makeCtx(client)

    expect(await runFunnels(['run', 'signup'], ctx)).toBe(0)
    // The table is the point: it is what the throw used to take with it.
    expect(out.join('')).toContain('signed_up')
    expect(errOut.join('')).not.toContain('warning:')
  })

  it('keeps stdout parseable as one JSON object per line', async () => {
    const { client } = makeClient({ get: LIST, post: RUN })
    const { ctx, out } = makeCtx(client)
    await runFunnels(['run', 'signup', '--json'], ctx)
    const lines = out.join('').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('omits since/until when not given, leaving the default to the server', async () => {
    // Two defaults in one product is one too many; the one that drifts is
    // invisible.
    const { client, calls } = makeClient({ get: LIST, post: RUN })
    const { ctx } = makeCtx(client)
    await runFunnels(['run', 'signup'], ctx)
    expect(calls[1]?.arg).toEqual({})
  })

  it('resolves a relative --since against the injected clock', async () => {
    const { client, calls } = makeClient({ get: LIST, post: RUN })
    const { ctx } = makeCtx(client)
    await runFunnels(['run', 'signup', '--since', '1h'], ctx)
    expect(calls[1]?.arg).toEqual({ since: '2026-08-14T11:00:00.000Z' })
  })

  it('rejects an inverted window before sending it', async () => {
    const { client, calls } = makeClient({ get: LIST, post: RUN })
    const { ctx } = makeCtx(client)
    const code = await runFunnels(
      ['run', 'signup', '--since', '2026-08-14T12:00:00Z', '--until', '2026-08-13T12:00:00Z'],
      ctx,
    )
    expect(code).not.toBe(0)
    expect(calls.some((c) => c.method === 'post')).toBe(false)
  })

  it('requires a name for run and for dropoff', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['run'], ctx)).not.toBe(0)
    expect(await runFunnels(['dropoff'], ctx)).not.toBe(0)
  })

  it('does not echo an unknown funnel name back', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx, errOut } = makeCtx(client)
    expect(await runFunnels(['run', 'not-a-funnel'], ctx)).not.toBe(0)
    expect(errOut.join('')).not.toContain('not-a-funnel')
  })

  it('does not echo an unknown subcommand back', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx, errOut } = makeCtx(client)
    expect(await runFunnels(['sudo-rm-rf'], ctx)).not.toBe(0)
    expect(errOut.join('')).not.toContain('sudo-rm-rf')
  })

  it('rejects --step 0, because steps are numbered from 1', async () => {
    // A 0-indexed caller would otherwise read step 2's drop-offs as step 1's
    // and never see an error.
    const { client, calls } = makeClient({ get: LIST, post: { people: [] } })
    const { ctx, errOut } = makeCtx(client)
    expect(await runFunnels(['dropoff', 'signup', '--step', '0'], ctx)).not.toBe(0)
    expect(errOut.join('')).toContain('numbered from 1')
    expect(calls.some((c) => c.path.includes('dropoff'))).toBe(false)
  })

  it('rejects a non-numeric --step', async () => {
    const { client } = makeClient({ get: LIST, post: { people: [] } })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['dropoff', 'signup', '--step', 'two'], ctx)).not.toBe(0)
  })

  it('requires --step for dropoff', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['dropoff', 'signup'], ctx)).not.toBe(0)
  })

  it('lists drop-offs, sending the step and paging cursor through', async () => {
    const dropoff = {
      step: 2,
      people: [{ person_id: 'u-1', entered_at: '2026-08-14T10:00:00.000Z' }],
      next_cursor: 'abc',
      window_exhausted: false,
      range: { since: 'a', until: 'b' },
      as_of: 'c',
    }
    const { client, calls } = makeClient({ get: LIST, post: dropoff })
    const { ctx, out, errOut } = makeCtx(client)
    expect(await runFunnels(['dropoff', 'signup', '--step', '2', '--cursor', 'xyz'], ctx)).toBe(0)
    expect(calls[1]).toMatchObject({ path: '/v1/funnels/3/dropoff' })
    expect(calls[1]?.arg).toMatchObject({ step: 2, cursor: 'xyz' })
    expect(out.join('')).toContain('u-1')
    // The cursor is a summary field, so it goes to stderr with the rest.
    expect(errOut.join('')).toContain('abc')
  })

  it('requires --file for preview', async () => {
    const { client } = makeClient({ post: RUN })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['preview'], ctx)).not.toBe(0)
  })

  it('reads a definition from --file and posts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyraflow-funnel-'))
    const path = join(dir, 'signup.json')
    writeFileSync(
      path,
      JSON.stringify({ steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 60 }),
    )
    const { client, calls } = makeClient({ post: RUN })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['preview', '--file', path], ctx)).toBe(0)
    expect(calls[0]).toMatchObject({ method: 'post', path: '/v1/funnels/preview' })
    expect(calls[0]?.arg).toMatchObject({ window_seconds: 60 })
  })

  it('fails cleanly when the definition file is missing or not JSON', async () => {
    const { client, calls } = makeClient({ post: RUN })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['preview', '--file', '/no/such/file.json'], ctx)).not.toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('rejects a flag the subcommand does not take', async () => {
    const { client } = makeClient({ get: LIST })
    const { ctx } = makeCtx(client)
    expect(await runFunnels(['list', '--step', '2'], ctx)).not.toBe(0)
  })
})
