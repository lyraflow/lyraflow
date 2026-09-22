/**
 * `runCreateProject` — issue #284. Split out of index.test.ts the same way
 * index.host-resolution.test.ts and index.epipe.test.ts already are, rather
 * than growing that file: this suite needs a real Postgres/ClickHouse pair
 * (`migrate` touches both, even though `createProject` itself only writes
 * to Postgres — see this repo's own `MigrateOptions`), which the rest of
 * index.test.ts does not.
 */
import { join } from 'node:path'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCreateProject } from './index.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

const createdProjectIds: number[] = []

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../db/migrations')),
    appSchemaVersion: 999,
  })
})

afterEach(async () => {
  if (createdProjectIds.length > 0) {
    await pg.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjectIds])
    createdProjectIds.length = 0
  }
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

/**
 * A FRESH `{ pg, ch }` pair per call — matching index.ts's own `clients()`,
 * which `runCreateProject` closes in its `finally` on every path (success
 * AND the duplicate-name error). The module-level `pg`/`ch` above are the
 * test rig's own connection, used for `migrate`/cleanup/assertions and nver
 * handed to `runCreateProject` itself — handing it the shared rig pool
 * would have the SECOND call in a test (the duplicate-name cases each call
 * `runCreateProject` twice) try to query a pool the first call already
 * ended, which is exactly what surfaced this while writing the test
 * ("Called end on pool more than once").
 */
function realClients() {
  return {
    pg: createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test'),
    ch: createChClient({
      url: 'http://localhost:8123',
      username: 'lyraflow',
      password: 'lyraflow',
      database: 'lyraflow_test',
    }),
  }
}

/** A `getClients` that fails the test the instant it is called — used for
 * every usage-error case, where the whole point is that `runCreateProject`
 * must not open a database connection at all before a name is known to be
 * present and well-formed argv has been parsed. */
function unreachableClients(): { pg: never; ch: never } {
  throw new Error('getClients should not be called for a usage error')
}

function fakeCtx(getClients: () => { pg: Pool; ch: ClickHouseClient }) {
  const out: string[] = []
  const errOut: string[] = []
  return {
    ctx: {
      write: (s: string) => out.push(s),
      writeErr: (s: string) => errOut.push(s),
      getClients,
    },
    out: () => out.join(''),
    errOut: () => errOut.join(''),
  }
}

describe('runCreateProject', () => {
  it('prints one NDJSON line matching POST /v1/projects field names under --json, and exits 0', async () => {
    const { ctx, out, errOut } = fakeCtx(realClients)
    const code = await runCreateProject(['CP JSON Success', '--json'], ctx)
    expect(code).toBe(0)
    expect(errOut()).toBe('')

    const lines = out().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0] as string) as Record<string, unknown>
    createdProjectIds.push(record.id as number)

    expect(record).toEqual({
      id: expect.any(Number),
      name: 'CP JSON Success',
      slug: 'cp-json-success',
      write_key: expect.stringMatching(/^wk_[0-9a-f]+$/),
      server_key: expect.stringMatching(/^sk_[0-9a-f]+$/),
    })
  })

  it('mutation: human output printed under --json fails this — the json line must be the ONLY thing on stdout, not the three human lines', async () => {
    const { ctx, out } = fakeCtx(realClients)
    const code = await runCreateProject(['CP JSON Shape', '--json'], ctx)
    expect(code).toBe(0)
    const record = JSON.parse(out().trim()) as { id: number }
    createdProjectIds.push(record.id)
    // The historic human phrasing must never appear on stdout under --json.
    expect(out()).not.toContain('created.')
    expect(out()).not.toContain('Write key')
    expect(out()).not.toContain('Server key')
  })

  it('prints the pre-existing three human lines, byte-identical, with no flag at all', async () => {
    const { ctx, out, errOut } = fakeCtx(realClients)
    const code = await runCreateProject(['CP Human Success'], ctx)
    expect(code).toBe(0)
    expect(errOut()).toBe('')

    const writeKeyMatch = /Write key {2}\(public, safe in browser JS\): (wk_[0-9a-f]+)/.exec(out())
    const serverKeyMatch = /Server key \(secret, shown once\): {9}(sk_[0-9a-f]+)/.exec(out())
    expect(writeKeyMatch?.[1]).toBeDefined()
    expect(serverKeyMatch?.[1]).toBeDefined()

    const row = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-human-success',
    ])
    const id = Number(row.rows[0]?.id)
    createdProjectIds.push(id)

    expect(out()).toBe(
      `Project "CP Human Success" created.\n  Write key  (public, safe in browser JS): ${writeKeyMatch?.[1]}\n  Server key (secret, shown once):         ${serverKeyMatch?.[1]}\n`,
    )
  })

  it('an explicit --human renders the same three lines as no flag at all', async () => {
    const { ctx: ctxA, out: outA } = fakeCtx(realClients)
    await runCreateProject(['CP Human Explicit A'], ctxA)
    const rowA = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-human-explicit-a',
    ])
    createdProjectIds.push(Number(rowA.rows[0]?.id))

    const { ctx: ctxB, out: outB } = fakeCtx(realClients)
    await runCreateProject(['CP Human Explicit B', '--human'], ctxB)
    const rowB = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-human-explicit-b',
    ])
    createdProjectIds.push(Number(rowB.rows[0]?.id))

    // Same shape (three lines, same prefixes) regardless of the explicit flag.
    expect(outA().split('\n')).toHaveLength(4) // 3 lines + trailing ''
    expect(outB().split('\n')).toHaveLength(4)
    expect(outA().startsWith('Project "CP Human Explicit A" created.\n')).toBe(true)
    expect(outB().startsWith('Project "CP Human Explicit B" created.\n')).toBe(true)
  })

  it('a duplicate name under --json writes {error, code: "project_exists"} to stderr and exits 1', async () => {
    const { ctx: first } = fakeCtx(realClients)
    await runCreateProject(['CP Dup JSON'], first)
    const row = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-dup-json',
    ])
    createdProjectIds.push(Number(row.rows[0]?.id))

    const { ctx: second, out, errOut } = fakeCtx(realClients)
    const code = await runCreateProject(['CP Dup JSON', '--json'], second)

    // mutation: "a wrong exit code for a duplicate name" fails exactly this.
    expect(code).toBe(1)
    expect(out()).toBe('')
    const parsed = JSON.parse(errOut().trim()) as { error: string; code: string }
    expect(parsed.code).toBe('project_exists')
    expect(parsed.error).toMatch(/cp-dup-json/)
  })

  it('a duplicate name in human mode prints the pre-existing message, byte-identical, and exits 1', async () => {
    const { ctx: first } = fakeCtx(realClients)
    await runCreateProject(['CP Dup Human'], first)
    const row = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-dup-human',
    ])
    createdProjectIds.push(Number(row.rows[0]?.id))

    const { ctx: second, out, errOut } = fakeCtx(realClients)
    const code = await runCreateProject(['CP Dup Human'], second)

    expect(code).toBe(1)
    expect(out()).toBe('')
    expect(errOut()).toBe(
      'A project with slug "cp-dup-human" already exists. Project names must be unique. Pick a different name, or look up the existing project\'s write key in the projects table.\n',
    )
  })

  it('mutation: human output changed fails this — the exact three-line phrasing is pinned', async () => {
    const { ctx, out } = fakeCtx(realClients)
    await runCreateProject(['CP Phrasing Pin'], ctx)
    const row = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
      'cp-phrasing-pin',
    ])
    createdProjectIds.push(Number(row.rows[0]?.id))
    expect(out()).toMatch(
      /^Project "CP Phrasing Pin" created\.\n {2}Write key {2}\(public, safe in browser JS\): wk_[0-9a-f]+\n {2}Server key \(secret, shown once\): {9}sk_[0-9a-f]+\n$/,
    )
  })

  it('no name at all: --json prints {error, code: "usage_error"}, exits 2, and never opens a database connection', async () => {
    const { ctx, out, errOut } = fakeCtx(unreachableClients)
    const code = await runCreateProject(['--json'], ctx)
    expect(code).toBe(2)
    expect(out()).toBe('')
    const parsed = JSON.parse(errOut().trim()) as { error: string; code: string }
    expect(parsed.code).toBe('usage_error')
    expect(parsed.error).toBe('Usage: lyraflow create-project <name>')
  })

  it('no name at all, human mode: the pre-existing usage line, byte-identical, exits 2, no database connection', async () => {
    const { ctx, out, errOut } = fakeCtx(unreachableClients)
    const code = await runCreateProject([], ctx)
    expect(code).toBe(2)
    expect(out()).toBe('')
    expect(errOut()).toBe('Usage: lyraflow create-project <name>\n')
  })

  it('an unrecognised flag is a usage error (exit 2, no database connection), not silently read as the project name', async () => {
    const { ctx, errOut } = fakeCtx(unreachableClients)
    const code = await runCreateProject(['--host', 'http://example.test', '--json'], ctx)
    expect(code).toBe(2)
    expect(JSON.parse(errOut().trim()).code).toBe('usage_error')
  })

  it('--json wins when both --json and --human are passed, same rule as every other command', async () => {
    const { ctx, out } = fakeCtx(realClients)
    const code = await runCreateProject(['CP Both Flags', '--json', '--human'], ctx)
    expect(code).toBe(0)
    const record = JSON.parse(out().trim()) as { id: number }
    createdProjectIds.push(record.id)
  })
})
