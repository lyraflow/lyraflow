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
import { ProjectDeletionStore } from '@lyraflow/server/dist/project/deletion-store.js'
import type { purgeProject } from '@lyraflow/server/dist/project/purge.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdminCommandContext } from './projects.js'
import {
  PROJECT_PURGE_LEASE_MS,
  PROJECT_PURGE_MAX_ATTEMPTS,
  resolveClaimDelayMs,
  runProjects,
} from './projects.js'

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

/**
 * Wraps a REAL `ProjectDeletionStore` (so `request`/`claimById`/`get` do
 * real, correct database work) while making `complete`/`fail` observable —
 * `runProjectsDelete`'s only two collaborators-by-side-effect that "the row
 * is gone" cannot distinguish from "never called at all" (the row being
 * gone, for a successful purge, is `purgeProject`'s own doing, not
 * `complete()`'s). Used together with an injected `purge` to drive the
 * claim-loses-the-race branch and both `deleted: false` outcomes directly.
 */
function spiedStore(pool: Pool) {
  const real = new ProjectDeletionStore(pool)
  const complete = vi.fn((id: number) => real.complete(id))
  const fail = vi.fn((id: number, error: string) => real.fail(id, error))
  const defer = vi.fn((id: number, note: string) => real.defer(id, note))
  const reopen = vi.fn((id: number) => real.reopen(id))
  const claimById = vi.fn(
    (id: number, opts: { leaseMs: number; maxAttempts: number; claimDelayMs: number }) =>
      real.claimById(id, opts),
  )
  return {
    complete,
    fail,
    defer,
    reopen,
    claimById,
    makeStore: () => ({
      request: (id: number) => real.request(id),
      reopen,
      claimById,
      complete,
      fail,
      defer,
      get: (id: number) => real.get(id),
    }),
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

  /**
   * The CLI and the server compute the claim delay from the SAME two
   * environment variables, so an install that tuned either one gets a CLI
   * that waits exactly as long as its own server's worker would. Asserted on
   * a TUNED environment as well as the default: two implementations that
   * agree on the shipped defaults and disagree on everything else would look
   * correct here with only the first case.
   */
  it('resolves the same claim delay config.ts derives, tuned or not', () => {
    const base = {
      LYRAFLOW_POSTGRES_URL: 'postgres://x',
      LYRAFLOW_CLICKHOUSE_URL: 'http://x',
      LYRAFLOW_CLICKHOUSE_USER: 'x',
      LYRAFLOW_CLICKHOUSE_PASSWORD: 'x',
      LYRAFLOW_CLICKHOUSE_DB: 'x',
    }
    const tuned = {
      LYRAFLOW_PROJECT_CACHE_TTL_MS: '12000',
      LYRAFLOW_FLUSH_INTERVAL_MS: '750',
    }
    for (const overrides of [{}, tuned]) {
      const before = { ...process.env }
      try {
        for (const [k, v] of Object.entries(tuned)) delete process.env[k]
        Object.assign(process.env, overrides)
        expect(resolveClaimDelayMs()).toBe(
          loadConfig({ ...base, ...overrides }).projectPurgeClaimDelayMs,
        )
      } finally {
        process.env = before
      }
    }
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
    // `claimDelayMs: 0` wherever this file drives a purge: the wait itself is
    // asserted end to end, against a live app's warm `ProjectCache`, in
    // `projects-cache-horizon.test.ts`. Every delete here is about consent,
    // exit codes or which request gets claimed, none of which the wait
    // changes — and none of which is worth a real minute of sleeping.
    expect(await runProjects(['delete', 'acme'], ctx, { claimDelayMs: 0 })).toBe(0)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(0)
  })

  // THE CONFIRMATION PIN.
  it('deletes nothing when the typed slug is wrong', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ answers: ['acme-typo'], stdinIsTty: true })
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(1)
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    expect(
      (await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [project.id]))
        .rows[0].count,
    ).toBe('0')
  })

  it('refuses to run unattended without --yes and writes no row', async () => {
    const project = await createProject(pg, 'Acme')
    // stdoutIsTty: true is deliberate — a `!ctx.stdoutIsTty` implementation
    // (checking the wrong stream) must fail this exact assertion instead of
    // accidentally passing it; the guard this pins is on STDIN alone.
    const ctx = fakeCtx({ stdinIsTty: false, stdoutIsTty: true })
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(2)
    expect(ctx.errLines().join('\n')).toContain('--yes')
    expect(
      (await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [project.id]))
        .rows[0].count,
    ).toBe('0')
  })

  it('--yes skips the prompt even at a terminal', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ stdinIsTty: true, answers: [] })
    expect(await runProjects(['delete', 'acme', '--yes'], ctx, { claimDelayMs: 0 })).toBe(0)
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
    expect(
      (await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [project.id]))
        .rows[0].count,
    ).toBe('1')
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

  // THE REGRESSION FOR THE CRITICAL: a `store.claim()` call (the worker's
  // own "whatever is oldest, queue-wide" query) here would silently
  // complete OLDER's request while purging TARGET's project — marking a
  // different project's deletion done while its data survives intact. This
  // is real, end to end: no stubs, real Postgres, real ClickHouse.
  it('claims only the request it filed, never an older pending request from another project', async () => {
    const older = await createProject(pg, 'Older')
    const queueCtx = fakeCtx({ stdinIsTty: true })
    expect(await runProjects(['delete', older.slug, '--yes', '--queue'], queueCtx)).toBe(0)
    // Backdate it so it is provably the OLDEST claimable row in the whole
    // table — exactly the row `store.claim()` (the worker's query) would
    // prefer over anything filed after it.
    await pg.query(
      "UPDATE project_deletions SET requested_at = now() - interval '1 hour' WHERE project_id = $1",
      [older.id],
    )

    const target = await createProject(pg, 'Target')
    const ctx = fakeCtx({ stdinIsTty: true, answers: [target.slug] })
    expect(await runProjects(['delete', target.slug], ctx, { claimDelayMs: 0 })).toBe(0)

    // target is fully gone.
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [target.id])).rowCount).toBe(0)

    // older's project row survives, and its own request was never touched —
    // never claimed, never completed, never failed, attempts still zero.
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [older.id])).rowCount).toBe(1)
    const olderReq = await pg.query(
      'SELECT completed_at, claimed_at, attempts FROM project_deletions WHERE project_id = $1',
      [older.id],
    )
    expect(olderReq.rows[0]).toMatchObject({ completed_at: null, claimed_at: null, attempts: 0 })
  })

  it('exits 1 and deletes nothing when the confirmation prompt itself rejects', async () => {
    const project = await createProject(pg, 'Acme')
    const ctx = fakeCtx({ stdinIsTty: true })
    ctx.prompt = () => Promise.reject(new Error('stream exploded'))
    expect(await runProjects(['delete', 'acme'], ctx)).toBe(1)
    expect(ctx.errLines().join('\n')).toContain('the confirmation prompt failed')
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    expect(
      (await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [project.id]))
        .rows[0].count,
    ).toBe('0')
  })

  it('reports pending with the last error after a failed attempt', async () => {
    const ctx = fakeCtx({ stdinIsTty: true })
    await createProject(pg, 'Acme')
    await runProjects(['delete', 'acme', '--yes', '--queue'], ctx)
    const id = Number(JSON.parse(ctx.lines()[0] as string).id)
    await pg.query('UPDATE project_deletions SET last_error = $2, attempts = 1 WHERE id = $1', [
      id,
      'boom',
    ])
    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    expect(JSON.parse(read.lines()[0] as string)).toMatchObject({
      status: 'pending',
      error: 'boom',
    })
  })

  it('reports failed once attempts are exhausted', async () => {
    const ctx = fakeCtx({ stdinIsTty: true })
    await createProject(pg, 'Acme')
    await runProjects(['delete', 'acme', '--yes', '--queue'], ctx)
    const id = Number(JSON.parse(ctx.lines()[0] as string).id)
    await pg.query(
      'UPDATE project_deletions SET attempts = $2, last_error = $3, claimed_at = NULL WHERE id = $1',
      [id, PROJECT_PURGE_MAX_ATTEMPTS, 'gave up'],
    )
    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    expect(JSON.parse(read.lines()[0] as string)).toMatchObject({
      status: 'failed',
      error: 'gave up',
    })
  })

  it('reports in_progress while the claim lease is live', async () => {
    const ctx = fakeCtx({ stdinIsTty: true })
    await createProject(pg, 'Acme')
    await runProjects(['delete', 'acme', '--yes', '--queue'], ctx)
    const id = Number(JSON.parse(ctx.lines()[0] as string).id)
    await pg.query('UPDATE project_deletions SET claimed_at = now(), attempts = 1 WHERE id = $1', [
      id,
    ])
    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    expect(JSON.parse(read.lines()[0] as string)).toMatchObject({ status: 'in_progress' })
  })

  it('reports completed with completed_at populated', async () => {
    const ctx = fakeCtx({ stdinIsTty: true })
    await createProject(pg, 'Acme')
    await runProjects(['delete', 'acme', '--yes', '--queue'], ctx)
    const id = Number(JSON.parse(ctx.lines()[0] as string).id)
    await pg.query('UPDATE project_deletions SET completed_at = now() WHERE id = $1', [id])
    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    const parsed = JSON.parse(read.lines()[0] as string)
    expect(parsed).toMatchObject({ status: 'completed' })
    expect(parsed.completed_at).not.toBeNull()
    expect(typeof parsed.completed_at).toBe('string')
  })

  /**
   * The command an operator reaches for after a delete has failed for good.
   * Asserted through the real store on a request that is genuinely past
   * `maxAttempts` — the state where nothing else in the product can move it.
   */
  it('resumes a permanently failed deletion, leaving its error on record', async () => {
    const project = await createProject(pg, 'Acme')
    const queueCtx = fakeCtx({ stdinIsTty: true })
    await runProjects(['delete', 'acme', '--yes', '--queue'], queueCtx)
    const found = await pg.query<{ id: string }>(
      'SELECT id FROM project_deletions WHERE project_id = $1',
      [project.id],
    )
    const id = Number(found.rows[0]?.id)
    await pg.query(
      "UPDATE project_deletions SET attempts = 5, claimed_at = now(), last_error = 'boom' WHERE id = $1",
      [id],
    )

    const read = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], read)).toBe(0)
    expect(JSON.parse(read.lines()[0] as string)).toMatchObject({ status: 'failed' })

    const retry = fakeCtx()
    expect(await runProjects(['deletion', 'retry', String(id), '--json'], retry)).toBe(0)
    expect(JSON.parse(retry.lines()[0] as string)).toMatchObject({
      id,
      project_id: project.id,
      status: 'pending',
      error: 'boom',
    })

    const again = fakeCtx()
    expect(await runProjects(['deletion', 'get', String(id), '--json'], again)).toBe(0)
    // Pending WITH the error, not failed: claimable again, and still saying
    // why the last attempt did not finish.
    expect(JSON.parse(again.lines()[0] as string)).toMatchObject({
      status: 'pending',
      error: 'boom',
    })
  })

  it('reports a deletion id with nothing to retry without touching anything', async () => {
    const ctx = fakeCtx()
    expect(await runProjects(['deletion', 'retry', '2147483000'], ctx)).toBe(1)
    expect(ctx.errLines().join('\n')).toContain('no deletion request')
  })

  it('rejects a deletion subcommand that is neither get nor retry', async () => {
    const ctx = fakeCtx()
    expect(await runProjects(['deletion', 'frobnicate', '1'], ctx)).toBe(2)
    // json mode (a non-TTY stdout), so the message arrives inside an object
    // rather than as bare prose.
    const { error } = JSON.parse(ctx.errLines()[0] as string) as { error: string }
    expect(error).toContain('expected "get" or "retry"')
  })

  it('rejects an unknown subcommand with usage on stderr and exit 2', async () => {
    const ctx = fakeCtx()
    expect(await runProjects(['frobnicate'], ctx)).toBe(2)
    expect(ctx.errLines().join('\n')).toContain('usage: lyraflow projects')
    expect(ctx.lines()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The seams `ProjectsDeps` exists for: `claim`, the `!request` branch, the
// retry pause, the `deleted: false` -> `fail` -> exit 1 path, and `complete`
// -- collectively exercised by nothing beyond "the row is gone" before this,
// which is exactly the shape that let the Critical (completing a request
// this process never filed) ship with twelve green tests.
// ---------------------------------------------------------------------------
describe('runProjects — injected deps (the claim race, the retry, and the store writes)', () => {
  it('leaves the request queued, untouched, when claimById cannot claim it', async () => {
    const project = await createProject(pg, 'Acme')
    const { claimById, makeStore } = spiedStore(pg)
    claimById.mockImplementation(async () => null)
    const purge = vi.fn(async () => ({ deleted: true, remaining: {} }))
    const ctx = fakeCtx({ stdinIsTty: true, answers: ['acme'] })

    const code = await runProjects(['delete', 'acme'], ctx, {
      purge: purge as unknown as typeof purgeProject,
      makeStore,
      claimDelayMs: 0,
    })

    expect(code).toBe(1)
    expect(claimById).toHaveBeenCalledTimes(1)
    expect(purge).not.toHaveBeenCalled()
    expect(ctx.errLines().join('\n')).toContain('could not be claimed here')
    const req = await pg.query(
      'SELECT completed_at, claimed_at, attempts FROM project_deletions WHERE project_id = $1',
      [project.id],
    )
    expect(req.rows[0]).toMatchObject({ completed_at: null, claimed_at: null, attempts: 0 })
  })

  /**
   * A reappearance hands the request BACK to the queue rather than failing
   * it: `defer`, not `fail`. Through `fail` the row keeps `claimed_at`, so
   * nothing may touch this half-torn-down project until the lease ages out —
   * thirty minutes by default — which also made the message this command
   * printed ("the server worker will finish it") wrong by three orders of
   * magnitude. The row state below is the whole assertion: no lease, no
   * attempt spent, and the reason on record.
   */
  it('hands the request back to the queue, unclaimed, when purge reports rows reappeared twice', async () => {
    const project = await createProject(pg, 'Acme')
    const { fail, defer, complete, makeStore } = spiedStore(pg)
    const purge = vi.fn(async () => ({ deleted: false, remaining: { events: 3 } }))
    const ctx = fakeCtx({ stdinIsTty: true, answers: ['acme'] })

    const code = await runProjects(['delete', 'acme'], ctx, {
      purge: purge as unknown as typeof purgeProject,
      makeStore,
      claimDelayMs: 0,
    })

    expect(code).toBe(1)
    expect(purge).toHaveBeenCalledTimes(2)
    expect(defer).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
    expect(ctx.errLines().join('\n')).toContain('rows reappeared')
    // The corrected promise: the next pass, not the end of the lease.
    expect(ctx.errLines().join('\n')).toContain('next pass')
    const req = await pg.query(
      'SELECT completed_at, claimed_at, attempts, last_error FROM project_deletions WHERE project_id = $1',
      [project.id],
    )
    expect(req.rows[0]).toMatchObject({ completed_at: null, claimed_at: null, attempts: 0 })
    expect(req.rows[0].last_error).toContain('rows reappeared during purge')
  })

  it('recovers on retry: completes the request when the second purge attempt succeeds', async () => {
    const project = await createProject(pg, 'Acme')
    const { fail, complete, makeStore } = spiedStore(pg)
    let calls = 0
    const purge = vi.fn(async () => {
      calls++
      return calls === 1
        ? { deleted: false, remaining: { events: 1 } }
        : { deleted: true, remaining: {} }
    })
    const ctx = fakeCtx({ stdinIsTty: true, answers: ['acme'] })

    const code = await runProjects(['delete', 'acme'], ctx, {
      purge: purge as unknown as typeof purgeProject,
      makeStore,
      claimDelayMs: 0,
    })

    expect(code).toBe(0)
    expect(purge).toHaveBeenCalledTimes(2)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(fail).not.toHaveBeenCalled()
    const req = await pg.query('SELECT completed_at FROM project_deletions WHERE project_id = $1', [
      project.id,
    ])
    expect(req.rows[0].completed_at).not.toBeNull()
  })
})
