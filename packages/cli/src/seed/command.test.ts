/**
 * The command layer, driven against fake database handles.
 *
 * Deliberately no live Postgres or ClickHouse here: everything this file
 * checks — argument handling, what gets written, what never gets written, and
 * what is printed — is decided before a real database would add anything but
 * latency. `insert.test.ts` is the one that proves the writes land, against
 * real services.
 */

import type { ClickHouseClient, Pool } from '@lyraflow/db'
import { describe, expect, it } from 'vitest'
import { UsageError } from '../api/args.js'
import {
  DEFAULT_DAYS,
  DEFAULT_EVENTS,
  DEFAULT_PERSONS,
  DEFAULT_SEED,
  SEED_USAGE,
  type SeedConnection,
  type SeedContext,
  parseSeedArgs,
  runSeedDemo,
} from './command.js'

const NOW = new Date('2026-08-17T12:00:00.000Z')

interface Recorder {
  pgQueries: string[]
  chInserts: Array<{ table: string; rows: unknown[] }>
  chCommands: string[]
  closed: number
}

function fakeConnection(opts: { project?: { id: string; name: string } | null } = {}): {
  connection: SeedConnection
  recorder: Recorder
} {
  const project = opts.project === undefined ? { id: '3', name: 'Demo Project' } : opts.project
  const recorder: Recorder = { pgQueries: [], chInserts: [], chCommands: [], closed: 0 }

  const pg = {
    query: async (text: string, params: unknown[]) => {
      recorder.pgQueries.push(text)
      if (text.includes('FROM projects')) return { rows: project === null ? [] : [project] }
      // `IdentityBindings.bind`'s upsert, which reports what it wrote through
      // RETURNING. Answering with the person id is the "written" outcome.
      if (text.includes('identity_bindings')) return { rows: [{ person_id: params[2] }] }
      return { rows: [] }
    },
  } as unknown as Pool

  const ch = {
    insert: async (args: { table: string; values: unknown[] }) => {
      recorder.chInserts.push({ table: args.table, rows: args.values })
    },
    command: async (args: { query: string }) => {
      recorder.chCommands.push(args.query)
    },
  } as unknown as ClickHouseClient

  return {
    connection: {
      pg,
      ch,
      database: 'lyraflow_test',
      close: async () => {
        recorder.closed++
      },
    },
    recorder,
  }
}

function fakeContext(isTty = false): SeedContext & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    write: (s) => {
      out.push(s)
    },
    writeErr: (s) => {
      err.push(s)
    },
    isTty,
    now: () => NOW,
  }
}

function rowsInserted(recorder: Recorder): unknown[] {
  return recorder.chInserts.flatMap((i) => i.rows)
}

describe('parseSeedArgs', () => {
  it('applies the documented defaults', () => {
    const args = parseSeedArgs(['my-demo'], NOW)
    expect(args).toEqual({
      project: 'my-demo',
      persons: DEFAULT_PERSONS,
      events: DEFAULT_EVENTS,
      days: DEFAULT_DAYS,
      seed: DEFAULT_SEED,
      anchor: NOW,
    })
  })

  it('slugifies the project the same way create-project does', () => {
    expect(parseSeedArgs(['My Demo App'], NOW).project).toBe('my-demo-app')
  })

  it('reads every count from its flag', () => {
    const args = parseSeedArgs(
      ['demo', '--persons', '12', '--events', '300', '--days', '7', '--seed', '99'],
      NOW,
    )
    expect(args.persons).toBe(12)
    expect(args.events).toBe(300)
    expect(args.days).toBe(7)
    expect(args.seed).toBe(99)
  })

  it('accepts an anchor as an instant or as a duration before now', () => {
    expect(parseSeedArgs(['demo', '--anchor', '2026-01-02T03:04:05Z'], NOW).anchor).toEqual(
      new Date('2026-01-02T03:04:05Z'),
    )
    expect(parseSeedArgs(['demo', '--anchor', '36h'], NOW).anchor).toEqual(
      new Date(NOW.getTime() - 36 * 3_600_000),
    )
  })

  it('rejects a bad count, naming the flag and never the value', () => {
    // Values chosen so they cannot appear inside the range the message
    // legitimately states -- "between 1 and 200000" contains the digit 0, so
    // testing `--persons 0` here would fail on the message's own text rather
    // than on an echo. The boundary values themselves are covered below.
    for (const [flag, value] of [
      ['persons', 'zero'],
      ['events', 'lots'],
      ['days', '-3'],
      ['seed', '1.5'],
      ['persons', '4000001'],
    ] as const) {
      let message = ''
      try {
        parseSeedArgs(['demo', `--${flag}`, value], NOW)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toContain(`--${flag}`)
      // The rule args.ts documents at length: a flag value is whatever the
      // caller typed, and CLI output lands in shell history and transcripts.
      expect(message).not.toContain(value)
    }
  })

  it('rejects a count outside its documented range', () => {
    for (const args of [
      ['demo', '--persons', '0'],
      ['demo', '--events', '0'],
      ['demo', '--days', '0'],
      ['demo', '--days', '3651'],
      ['demo', '--seed', '4294967296'],
      ['demo', '--seed', ''],
    ]) {
      expect(() => parseSeedArgs(args, NOW), args.join(' ')).toThrow(UsageError)
    }
  })

  it('accepts the extremes of each documented range', () => {
    expect(parseSeedArgs(['demo', '--seed', '0'], NOW).seed).toBe(0)
    expect(parseSeedArgs(['demo', '--seed', '4294967295'], NOW).seed).toBe(4_294_967_295)
    expect(parseSeedArgs(['demo', '--days', '3650'], NOW).days).toBe(3_650)
  })

  it('rejects a project name with nothing sluggable in it', () => {
    expect(() => parseSeedArgs(['!!!'], NOW)).toThrow(/letter or a digit/)
  })

  it('rejects an unexpected extra positional by position, never by value', () => {
    let message = ''
    try {
      parseSeedArgs(['demo', 'sk_secret_looking_value'], NOW)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/unexpected positional/)
    expect(message).not.toContain('sk_secret_looking_value')
  })
})

describe('runSeedDemo argument failures', () => {
  it('prints the usage line and exits 2 when the project is missing', async () => {
    const ctx = fakeContext()
    const code = await runSeedDemo([], ctx, () => {
      throw new Error('must not connect')
    })
    expect(code).toBe(2)
    expect(ctx.err.join('')).toContain('usage: lyraflow seed-demo')
    expect(ctx.err.join('')).toContain('--seed')
  })

  /**
   * The reason `connect` is a callback. A usage error must not open a Postgres
   * pool and a ClickHouse client that then have to be torn down — and the only
   * way to prove that is a `connect` which fails loudly if it is ever reached.
   */
  it('never opens a database connection for a usage error', async () => {
    const ctx = fakeContext()
    for (const args of [[], ['demo', '--persons', 'many'], ['demo', '--events', '3']]) {
      const code = await runSeedDemo(args, ctx, () => {
        throw new Error('connect() must not be called for a usage error')
      })
      expect(code).toBe(2)
    }
  })

  it('exits 2 when --events cannot cover the funnel, and says so', async () => {
    const ctx = fakeContext()
    const code = await runSeedDemo(['demo', '--persons', '500', '--events', '5'], ctx, () => {
      throw new Error('must not connect')
    })
    expect(code).toBe(2)
    expect(ctx.err.join('')).toMatch(/--events is too small/)
  })

  it('prints the full help, including the additive warning, for --help', async () => {
    const ctx = fakeContext()
    const code = await runSeedDemo(['--help'], ctx, () => {
      throw new Error('must not connect')
    })
    expect(code).toBe(0)
    const help = ctx.out.join('')
    expect(help).toContain(SEED_USAGE)
    expect(help).toContain('IT ONLY EVER INSERTS')
    expect(help).toContain('Running it again ADDS another cohort')
    expect(help).toContain('WRITES TO THE DATABASES DIRECTLY')
  })
})

describe('runSeedDemo writes', () => {
  it('inserts exactly the requested number of event rows, into events', async () => {
    const ctx = fakeContext()
    const { connection, recorder } = fakeConnection()
    const code = await runSeedDemo(
      ['demo', '--persons', '20', '--events', '250', '--days', '30'],
      ctx,
      () => connection,
    )
    expect(code).toBe(0)
    expect(rowsInserted(recorder)).toHaveLength(250)
    for (const insert of recorder.chInserts) expect(insert.table).toBe('events')
    expect(recorder.closed).toBe(1)
  })

  it('writes an identity binding for every identified person', async () => {
    const ctx = fakeContext()
    const { connection, recorder } = fakeConnection()
    await runSeedDemo(['demo', '--persons', '40', '--events', '500'], ctx, () => connection)

    const binds = recorder.pgQueries.filter((q) => q.includes('identity_bindings'))
    const summary = JSON.parse(ctx.out.join('')) as { identity_bindings_written: number }
    expect(binds.length).toBe(summary.identity_bindings_written)
    expect(binds.length).toBeGreaterThan(0)
  })

  it('asks ClickHouse to reload the identity dictionary once the bindings exist', async () => {
    const ctx = fakeContext()
    const { connection, recorder } = fakeConnection()
    await runSeedDemo(['demo', '--persons', '20', '--events', '250'], ctx, () => connection)
    expect(recorder.chCommands).toEqual([
      'SYSTEM RELOAD DICTIONARY lyraflow_test.identity_bindings',
    ])
  })

  /**
   * ADDITIVE ONLY, asserted rather than asserted-in-prose. Nothing this command
   * issues may be able to remove data: an operator who mistypes a project name
   * must lose nothing.
   */
  it('issues no statement that could delete, truncate or overwrite anything', async () => {
    const ctx = fakeContext()
    const { connection, recorder } = fakeConnection()
    await runSeedDemo(['demo', '--persons', '30', '--events', '400'], ctx, () => connection)

    const statements = [...recorder.pgQueries, ...recorder.chCommands]
    expect(statements.length).toBeGreaterThan(0)
    for (const sql of statements) {
      expect(sql).not.toMatch(/\b(DELETE|DROP|TRUNCATE|ALTER)\b/i)
    }
    // The only Postgres writes are the binding upserts; the only read is the
    // project lookup.
    for (const sql of recorder.pgQueries) {
      expect(sql.trim().toUpperCase().startsWith('SELECT') || sql.includes('INSERT INTO')).toBe(
        true,
      )
    }
  })

  it('produces the same rows for one seed and different rows for another', async () => {
    const run = async (seed: string) => {
      const ctx = fakeContext()
      const { connection, recorder } = fakeConnection()
      await runSeedDemo(
        [
          'demo',
          '--persons',
          '25',
          '--events',
          '300',
          '--seed',
          seed,
          '--anchor',
          NOW.toISOString(),
        ],
        ctx,
        () => connection,
      )
      return JSON.stringify(rowsInserted(recorder))
    }

    expect(await run('11')).toBe(await run('11'))
    expect(await run('11')).not.toBe(await run('12'))
  })
})

describe('runSeedDemo output', () => {
  it('reports the population, the window and the funnel as json', async () => {
    const ctx = fakeContext()
    const { connection } = fakeConnection()
    const code = await runSeedDemo(
      ['demo', '--persons', '50', '--events', '700', '--days', '45', '--seed', '8', '--json'],
      ctx,
      () => connection,
    )
    expect(code).toBe(0)

    const summary = JSON.parse(ctx.out.join('')) as Record<string, unknown>
    expect(summary.command).toBe('seed-demo')
    expect(summary.project).toEqual({ id: 3, name: 'Demo Project', slug: 'demo' })
    expect(summary.seed).toBe(8)
    expect(summary.days).toBe(45)
    expect(summary.persons).toBe(50)
    expect(summary.events).toBe(700)
    expect(summary.additive_only).toBe(true)
    expect(summary.identity_dictionary_reloaded).toBe(true)
    expect(Array.isArray(summary.funnel)).toBe(true)
    expect((summary.funnel as Array<{ event: string }>)[0]?.event).toBe('$page')
    expect(new Date(summary.earliest as string).getTime()).toBeLessThan(
      new Date(summary.latest as string).getTime(),
    )
  })

  it('renders a readable block, including the additive note, for a human', async () => {
    const ctx = fakeContext(true)
    const { connection } = fakeConnection()
    await runSeedDemo(
      ['demo', '--persons', '20', '--events', '250', '--human'],
      ctx,
      () => connection,
    )

    const text = ctx.out.join('')
    expect(text).toContain('Seeded demo data into project "Demo Project" (id 3).')
    expect(text).toContain('persons          20')
    expect(text).toContain('funnel           $page')
    expect(text).toContain('This command only inserts.')
  })

  it('says so, and exits 1, when the project does not exist', async () => {
    const ctx = fakeContext()
    const { connection, recorder } = fakeConnection({ project: null })
    const code = await runSeedDemo(
      ['demo', '--persons', '5', '--events', '60'],
      ctx,
      () => connection,
    )

    expect(code).toBe(1)
    expect(ctx.err.join('')).toContain('No project with that name or slug')
    expect(recorder.chInserts).toHaveLength(0)
    // Whatever happens, the handles are released.
    expect(recorder.closed).toBe(1)
  })
})
