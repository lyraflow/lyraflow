import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import {
  SCHEMA_DEFAULT_LIMIT,
  SCHEMA_MAX_LIMIT,
  runDeletions,
  runSchema,
  runSegments,
} from './catalog.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')

interface FakeCall {
  method: 'get' | 'post'
  path: string
  arg?: Record<string, string | number | undefined> | unknown
}

interface FakeClientOpts {
  get?: unknown | Error
  post?: unknown | Error
}

function makeClient(opts: FakeClientOpts): { client: Client; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client = {
    get: async (path: string, query: Record<string, string | number | undefined> = {}) => {
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
      prompt: () => Promise.reject(new Error('these commands never prompt')),
      ...overrides,
    },
    out,
    errOut,
  }
}

function parseJsonLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// --- deletions --------------------------------------------------------

describe('runDeletions', () => {
  it('prints a deletion request status', async () => {
    const status = {
      status: 'completed',
      requested_at: '2026-08-01T00:00:00.000Z',
      completed_at: '2026-08-01T00:05:00.000Z',
    }
    const { client, calls } = makeClient({ get: status })
    const { ctx, out } = makeCtx(client)
    const code = await runDeletions(['get', '7'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', path: '/v1/deletions/7', arg: {} }])
    expect(parseJsonLines(out)).toEqual([status])
  })

  it('a 404 (unknown deletion id) is exit 1', async () => {
    const { client } = makeClient({ get: new ApiError(404, 'deletion_not_found', 'not found') })
    const { ctx } = makeCtx(client)
    const code = await runDeletions(['get', '999'], ctx)
    expect(code).toBe(1)
  })

  it('requires an id', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runDeletions(['get'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('requires a subcommand', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runDeletions([], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown subcommand without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({})
    const { ctx, errOut } = makeCtx(client)
    const code = await runDeletions([SECRET, '7'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('rejects an unexpected extra positional without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({ get: {} })
    const { ctx, errOut } = makeCtx(client)
    const code = await runDeletions(['get', '7', SECRET], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })
})

// --- segments -----------------------------------------------------------

describe('runSegments > list', () => {
  const SEGMENTS = [
    {
      id: 1,
      name: 'active users',
      ast_version: 1,
      filter: {},
      stale: false,
      last_count: 42,
      last_evaluated_at: '2026-08-08T10:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-08T10:00:00.000Z',
    },
  ]

  it('lists saved segments', async () => {
    const { client, calls } = makeClient({ get: { segments: SEGMENTS } })
    const { ctx, out } = makeCtx(client)
    const code = await runSegments(['list'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', path: '/v1/segments', arg: {} }])
    expect(parseJsonLines(out)).toEqual(SEGMENTS)
  })

  it('renders a human-mode table with the pinned column names', async () => {
    const { client } = makeClient({ get: { segments: SEGMENTS } })
    const { ctx, out } = makeCtx(client, { isTty: true })
    await runSegments(['list', '--human'], ctx)
    const header = out.join('').split('\n')[0]
    expect(header).toContain('id')
    expect(header).toContain('name')
    expect(header).toContain('last_count')
    expect(header).toContain('last_evaluated_at')
    expect(header).toContain('stale')
  })

  it('an ApiError propagates as exit 1', async () => {
    const { client } = makeClient({ get: new ApiError(503, 'draining', 'retry') })
    const { ctx } = makeCtx(client)
    const code = await runSegments(['list'], ctx)
    expect(code).toBe(1)
  })

  it('rejects an unexpected positional after list', async () => {
    const { client, calls } = makeClient({ get: { segments: [] } })
    const { ctx } = makeCtx(client)
    const code = await runSegments(['list', 'extra'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

describe('runSegments > run', () => {
  const SUMMARY_ONLY = { person_count: 5, as_of: '2026-08-08T12:00:00.000Z' }
  const WITH_MEMBERS = {
    person_count: 2,
    as_of: '2026-08-08T12:00:00.000Z',
    members: [
      {
        person_id: 'p1',
        first_seen: '2026-08-01T00:00:00.000Z',
        last_seen: '2026-08-08T00:00:00.000Z',
      },
      {
        person_id: 'p2',
        first_seen: '2026-08-02T00:00:00.000Z',
        last_seen: '2026-08-07T00:00:00.000Z',
      },
    ],
    next_cursor: null,
    window_exhausted: true,
  }

  it('runs a saved segment by id (count only, no --members)', async () => {
    const { client, calls } = makeClient({ post: SUMMARY_ONLY })
    const { ctx, out } = makeCtx(client)
    const code = await runSegments(['run', '1'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'post', path: '/v1/segments/1/preview', arg: {} }])
    expect(parseJsonLines(out)).toEqual([SUMMARY_ONLY])
  })

  it('--members sends include: ["members"], prints member rows on stdout and the summary on stderr', async () => {
    const { client, calls } = makeClient({ post: WITH_MEMBERS })
    const { ctx, out, errOut } = makeCtx(client)
    const code = await runSegments(['run', '1', '--members'], ctx)
    expect(code).toBe(0)
    expect(calls[0]?.arg).toEqual({ include: ['members'] })
    const shown = parseJsonLines(out)
    expect(shown).toEqual(WITH_MEMBERS.members)
    const summary = parseJsonLines(errOut)[0]
    expect(summary?.person_count).toBe(2)
    expect(summary?.members).toBeUndefined()
  })

  it('--cursor rides along in the request body', async () => {
    const { client, calls } = makeClient({ post: WITH_MEMBERS })
    const { ctx } = makeCtx(client)
    await runSegments(['run', '1', '--members', '--cursor', 'abc123'], ctx)
    expect(calls[0]?.arg).toEqual({ include: ['members'], cursor: 'abc123' })
  })

  it('requires an id', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runSegments(['run'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('a 404 (unknown segment) is exit 1', async () => {
    const { client } = makeClient({ post: new ApiError(404, 'segment_not_found', 'not found') })
    const { ctx } = makeCtx(client)
    const code = await runSegments(['run', '999'], ctx)
    expect(code).toBe(1)
  })

  it('URL-encodes the id in the preview path', async () => {
    const { client, calls } = makeClient({ post: SUMMARY_ONLY })
    const { ctx } = makeCtx(client)
    await runSegments(['run', 'a b'], ctx)
    expect(calls[0]?.path).toBe('/v1/segments/a%20b/preview')
  })
})

describe('runSegments > usage', () => {
  it('rejects an unknown subcommand without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({})
    const { ctx, errOut } = makeCtx(client)
    const code = await runSegments([SECRET], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('requires a subcommand', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runSegments([], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

// --- schema ---------------------------------------------------------------

describe('runSchema > events', () => {
  it('lists schema events', async () => {
    const events = [{ event_name: 'signup' }, { event_name: 'page_view' }]
    const { client, calls } = makeClient({ get: { events } })
    const { ctx, out } = makeCtx(client)
    const code = await runSchema(['events'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        method: 'get',
        path: '/v1/schema/events',
        arg: { q: undefined, limit: SCHEMA_DEFAULT_LIMIT },
      },
    ])
    expect(parseJsonLines(out)).toEqual(events)
  })

  it('passes --q through as a prefix filter', async () => {
    const { client, calls } = makeClient({ get: { events: [] } })
    const { ctx } = makeCtx(client)
    await runSchema(['events', '--q', 'sign'], ctx)
    expect(calls[0]?.arg).toMatchObject({ q: 'sign' })
  })

  it('rejects a non-numeric --limit without calling the API', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runSchema(['events', '--limit', 'abc'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it("rejects a --limit above the server's own ceiling", async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runSchema(['events', '--limit', '101'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('accepts a --limit exactly at the ceiling', async () => {
    const { client, calls } = makeClient({ get: { events: [] } })
    const { ctx } = makeCtx(client)
    const code = await runSchema(['events', '--limit', String(SCHEMA_MAX_LIMIT)], ctx)
    expect(code).toBe(0)
    expect(calls[0]?.arg).toMatchObject({ limit: SCHEMA_MAX_LIMIT })
  })
})

describe('runSchema > properties', () => {
  it('lists schema properties', async () => {
    const properties = [{ property_key: 'plan', value_kind: 'string' }]
    const { client, calls } = makeClient({ get: { properties } })
    const { ctx, out } = makeCtx(client)
    const code = await runSchema(['properties'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([
      {
        method: 'get',
        path: '/v1/schema/properties',
        arg: { q: undefined, event: undefined, limit: SCHEMA_DEFAULT_LIMIT },
      },
    ])
    expect(parseJsonLines(out)).toEqual(properties)
  })

  it('passes --event through to scope the property list', async () => {
    const { client, calls } = makeClient({ get: { properties: [] } })
    const { ctx } = makeCtx(client)
    await runSchema(['properties', '--event', 'signup'], ctx)
    expect(calls[0]?.arg).toMatchObject({ event: 'signup' })
  })
})

describe('runSchema > usage', () => {
  it('requires a subcommand', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runSchema([], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown subcommand without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({})
    const { ctx, errOut } = makeCtx(client)
    const code = await runSchema([SECRET], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('rejects an unexpected extra positional', async () => {
    const { client, calls } = makeClient({ get: { events: [] } })
    const { ctx } = makeCtx(client)
    const code = await runSchema(['events', 'extra'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

describe('SCHEMA_MAX_LIMIT / SCHEMA_DEFAULT_LIMIT', () => {
  it("matches the server's own SCHEMA_MAX_LIMIT, so the two cannot silently drift", () => {
    // Same technique events.test.ts uses for EVENTS_MAX_LIMIT: read the
    // independent source of truth off disk rather than trust a hand-copy.
    const routesSrc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', '..', 'server', 'src', 'schema', 'routes.ts'),
      'utf8',
    )
    const maxMatch = /export const SCHEMA_MAX_LIMIT = (\d+)/.exec(routesSrc)
    expect(maxMatch).not.toBeNull()
    expect(Number(maxMatch?.[1])).toBe(SCHEMA_MAX_LIMIT)

    const defaultMatch =
      /limit:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(\)\.max\(SCHEMA_MAX_LIMIT\)\.default\((\d+)\)/.exec(
        routesSrc,
      )
    expect(defaultMatch).not.toBeNull()
    expect(Number(defaultMatch?.[1])).toBe(SCHEMA_DEFAULT_LIMIT)
  })
})
