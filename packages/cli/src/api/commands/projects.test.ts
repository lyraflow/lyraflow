import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createProject as coreCreateProject } from '@lyraflow/core'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import { loadConfig } from '@lyraflow/server/dist/config.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AdminCommandContext } from './projects.js'
import { PROJECT_PURGE_LEASE_MS, PROJECT_PURGE_MAX_ATTEMPTS, runProjects } from './projects.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

// Real `@lyraflow/core` createProject, not a raw INSERT: this suite's own
// test cases (see 'lists projects with a derived state column') assert
// against the ACTUAL slugify-derived slug ('live', 'archived'), which a
// prefixed synthetic slug (the convention every other project-table suite
// uses) cannot produce. Every id this returns is tracked below and
// cleaned up by id, so a shared name across tests never has to mean a
// shared slug.
const createdProjectIds: number[] = []
async function createProject(
  db: Pool,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  const created = await coreCreateProject(db, name)
  const id = Number(created.id)
  createdProjectIds.push(id)
  return { id, slug: created.slug, name: created.name }
}

/**
 * `n` events for `projectId` — same fixture shape as purge.test.ts's own
 * `insertEvents`, trimmed to this file's needs (only `--queue`'s "left
 * ClickHouse untouched" test reads it back).
 */
async function insertEvents(
  chClient: ClickHouseClient,
  projectId: number,
  n: number,
): Promise<void> {
  const now = Date.now()
  await chClient.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: Array.from({ length: n }, (_, i) => ({
      project_id: projectId,
      event_id: randomUUID(),
      anonymous_id: `projectscli-anon-${randomUUID()}`,
      user_id: '',
      event_name: `projectscli_event_${i}`,
      timestamp: new Date(now + i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
      received_at: new Date(now + i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
      trusted: 0,
      properties: { kind: 'projectscli' },
      properties_num: { n: i },
    })),
  })
}

async function countFor(
  chClient: ClickHouseClient,
  table: string,
  projectId: number,
): Promise<number> {
  const rs = await chClient.query({
    query: `SELECT count() AS n FROM ${table} WHERE project_id = {p:UInt32}`,
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ n: string }>()
  return Number(rows[0]?.n ?? 0)
}

function fakeCtx(
  opts: { answers?: (string | null)[]; stdinIsTty?: boolean; stdoutIsTty?: boolean } = {},
): AdminCommandContext & { lines: () => string[]; errLines: () => string[] } {
  const out: string[] = []
  const errOut: string[] = []
  const answers = [...(opts.answers ?? [])]
  const toLines = (buf: string[]): string[] =>
    buf
      .join('')
      .split('\n')
      .filter((l) => l.length > 0)
  return {
    pg,
    ch,
    write: (s) => out.push(s),
    writeErr: (s) => errOut.push(s),
    prompt: async () => (answers.length > 0 ? (answers.shift() as string | null) : null),
    stdinIsTty: opts.stdinIsTty ?? false,
    stdoutIsTty: opts.stdoutIsTty ?? false,
    lines: () => toLines(out),
    errLines: () => toLines(errOut),
  }
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../../db/migrations')),
    appSchemaVersion: 999,
  })
})

afterEach(async () => {
  if (createdProjectIds.length > 0) {
    await pg.query('DELETE FROM project_deletions WHERE project_id = ANY($1)', [createdProjectIds])
    await pg.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjectIds])
    createdProjectIds.length = 0
  }
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('PROJECT_PURGE_LEASE_MS / PROJECT_PURGE_MAX_ATTEMPTS', () => {
  it("match config.ts's own defaults for the server worker", () => {
    const config = loadConfig({
      LYRAFLOW_POSTGRES_URL: 'postgres://x',
      LYRAFLOW_CLICKHOUSE_URL: 'http://x',
      LYRAFLOW_CLICKHOUSE_USER: 'x',
      LYRAFLOW_CLICKHOUSE_PASSWORD: 'x',
      LYRAFLOW_CLICKHOUSE_DB: 'x',
    })
    expect(PROJECT_PURGE_LEASE_MS).toBe(config.projectPurgeLeaseMs)
    expect(PROJECT_PURGE_MAX_ATTEMPTS).toBe(config.projectPurgeMaxAttempts)
  })
})

describe('runProjects', () => {
  it('lists projects with a derived state column', async () => {
    await createProject(pg, 'Live')
    const archived = await createProject(pg, 'Archived')
    await pg.query('UPDATE projects SET disabled_at = now() WHERE id = $1', [archived.id])
    const ctx = fakeCtx()
    expect(await runProjects(['list', '--json'], ctx)).toBe(0)
    const rows = ctx.lines().map((l) => JSON.parse(l))
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'live', state: 'active' }),
        expect.objectContaining({ slug: 'archived', state: 'archived' }),
      ]),
    )
  })

  it('never prints a key of either kind', async () => {
    await createProject(pg, 'Live')
    const ctx = fakeCtx()
    await runProjects(['list', '--json'], ctx)
    const text = ctx.lines().join('\n')
    expect(text).not.toMatch(/key/i)
  })

  it('deletes a project when the typed slug matches', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ answers: ['acme'], stdinIsTty: true })
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(0)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(0)
  })

  // THE CONFIRMATION PIN.
  it('deletes nothing when the typed slug is wrong', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ answers: ['acme-typo'], stdinIsTty: true })
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(1)
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    expect((await pg.query('SELECT count(*) FROM project_deletions')).rows[0].count).toBe('0')
  })

  it('refuses to run unattended without --yes and writes no row', async () => {
    await createProject(pg, 'Acme')
    const ctx = fakeCtx({ stdinIsTty: false })
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(2)
    expect(ctx.errLines().join('\n')).toContain('--yes')
    expect((await pg.query('SELECT count(*) FROM project_deletions')).rows[0].count).toBe('0')
  })

  it('--yes skips the prompt even at a terminal', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ stdinIsTty: true, answers: [] })
    expect(await runProjects(['delete', 'acme', '--yes'], ctx)).toBe(0)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(0)
  })

  it('--queue enqueues without touching ClickHouse', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    const ctx = fakeCtx({ stdinIsTty: true, answers: ['acme'] })
    expect(await runProjects(['delete', 'acme', '--queue'], ctx)).toBe(0)
    expect(await countFor(ch, 'events', project.id)).toBe(2)
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).not.toBeNull()
  })

  it('reports an unknown slug without writing anything', async () => {
    const ctx = fakeCtx({ stdinIsTty: true })
    expect(await runProjects(['delete', 'nope', '--yes'], ctx)).toBe(1)
    expect(ctx.errLines().join('\n')).toContain('nope')
  })

  it('names the in-flight request rather than queueing a second', async () => {
    const project = await createProject(pg, 'Acme')
    await pg.query('UPDATE projects SET deleting_at = now() WHERE id = $1', [project.id])
    await pg.query('INSERT INTO project_deletions (project_id, slug, name) VALUES ($1, $2, $3)', [
      project.id,
      'acme',
      'Acme',
    ])
    const ctx = fakeCtx({ stdinIsTty: true })
    expect(await runProjects(['delete', 'acme', '--yes'], ctx)).toBe(1)
    expect((await pg.query('SELECT count(*) FROM project_deletions')).rows[0].count).toBe('1')
  })

  it('reads a deletion status by id', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ stdinIsTty: true })
    await runProjects(['delete', 'acme', '--yes', '--queue'], ctx)
    const id = Number(JSON.parse(ctx.lines()[0] as string).id)
    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    expect(JSON.parse(read.lines()[0] as string)).toMatchObject({ status: 'pending' })
    // Keeps the fixture reachable for cleanup even though `project` itself
    // is never re-read after this point.
    expect(project.slug).toBe('acme')
  })

  it('rejects an unknown subcommand with usage on stderr and exit 2', async () => {
    const ctx = fakeCtx()
    expect(await runProjects(['frobnicate'], ctx)).toBe(2)
    expect(ctx.errLines().join('\n')).toContain('usage: lyraflow projects')
    expect(ctx.lines()).toEqual([])
  })
})
