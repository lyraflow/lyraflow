/**
 * THE CACHE-HORIZON PIN, end to end, over a live app and a live pair of
 * databases.
 *
 * The state it exists to make unreachable: `lyraflow projects delete` reports
 * success, and the very next event for that project is still ACCEPTED — its
 * rows landing in ClickHouse under a project id whose Postgres row no longer
 * exists. Nothing sweeps that data and nothing reports it, which is the
 * orphaned-project state the whole delete feature was built to prevent.
 *
 * Why it needs a real app rather than a stub: the accepting is done by
 * `ProjectCache`, an in-process map inside the SERVER, from a row it read
 * before the delete was ever filed. The CLI writes `deleting_at` straight to
 * Postgres and cannot reach that map — not through `projects.invalidate()`,
 * not through anything. The only thing that can close the gap is time, which
 * is what `purgeClaimDelayMs` (config.ts) computes and what
 * `ProjectDeletionStore`'s claim SQL enforces.
 *
 * The TTL is turned down to seconds through the same environment variable an
 * operator would use, and the CLI derives its wait from that same variable —
 * so this exercises the real derivation, not an injected number. It is
 * deliberately the one delete in this package that passes no `claimDelayMs`
 * override.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createProject } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { buildApp } from '@lyraflow/server/dist/app.js'
import { loadConfig } from '@lyraflow/server/dist/config.js'
import { Readiness } from '@lyraflow/server/dist/health.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { type AdminCommandContext, runProjects } from './projects.js'

const PG_URL = 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}

const pg = createPgPool(PG_URL)
const ch = createChClient(CH)

/**
 * Seconds, not the shipped minute: the wait this pins is
 * `ttl + flushInterval + CLAIM_DELAY_MARGIN_MS`, and the margin alone is five
 * seconds. Small enough to run, large enough that a purge with the delay
 * REMOVED (a sub-second teardown of a tiny project) finishes comfortably
 * inside the TTL — which is what makes the mutation visible here rather than
 * accidentally masked by a slow test machine.
 */
const CACHE_TTL_MS = 3_000
const FLUSH_INTERVAL_MS = 500

const envOverrides = {
  LYRAFLOW_PROJECT_CACHE_TTL_MS: String(CACHE_TTL_MS),
  LYRAFLOW_FLUSH_INTERVAL_MS: String(FLUSH_INTERVAL_MS),
}

let app: Awaited<ReturnType<typeof buildApp>>
let savedEnv: NodeJS.ProcessEnv
let projectId: number
let slug: string
let writeKey: string

function track(): Promise<{ status: number; error?: string }> {
  return app
    .inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': writeKey },
      payload: {
        type: 'track',
        message_id: randomUUID(),
        anonymous_id: 'horizon-probe',
        event: 'ping',
      },
    })
    .then((res) => ({
      status: res.statusCode,
      error: (res.json() as { error?: string }).error,
    }))
}

async function eventCount(): Promise<number> {
  const rs = await ch.query({
    query: 'SELECT count() AS n FROM events WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ n: string }>()
  return Number(rows[0]?.n ?? 0)
}

function ctx(): AdminCommandContext & { errText: () => string } {
  const err: string[] = []
  return {
    pg,
    ch,
    write: () => {},
    writeErr: (s) => err.push(s),
    prompt: async () => null,
    stdinIsTty: false,
    stdoutIsTty: false,
    errText: () => err.join(''),
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../../db/migrations')),
    appSchemaVersion: 999,
  })

  savedEnv = { ...process.env }
  Object.assign(process.env, envOverrides)

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: PG_URL,
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    ...envOverrides,
  } as NodeJS.ProcessEnv)

  const readiness = new Readiness()
  readiness.markReady()
  // No worker is started: `buildApp` deliberately never starts its timers
  // (see app.ts), so the only thing claiming anything here is the CLI call
  // this test makes.
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()

  const created = await createProject(pg, `Horizon ${Date.now()}`)
  projectId = Number(created.id)
  slug = created.slug
  writeKey = created.writeKey
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM project_deletions WHERE project_id = $1', [projectId])
  await pg.query('DELETE FROM projects WHERE id = $1', [projectId])
  await pg.end()
  await ch.close()
  process.env = savedEnv
})

it('waits out the ingest cache horizon, so nothing survives a completed delete', async () => {
  // Warms the write-key entry with a REAL event. Without this the cache is
  // cold and every later lookup reads Postgres, which would make this test
  // pass against the very defect it exists to catch.
  expect((await track()).status).toBe(202)

  const c = ctx()
  const run = runProjects(['delete', slug, '--yes'], c)

  // Keeps sending events for the whole of the delete. The early ones are
  // accepted — that is not a bug being tolerated, it is the window itself:
  // the server is answering out of a cache warmed before the stamp, and the
  // delay exists precisely so the teardown starts AFTER those events have
  // stopped and drained.
  const seen: { status: number; error?: string }[] = []
  let running = true
  const prober = (async () => {
    while (running) {
      seen.push(await track())
      await sleep(200)
    }
  })()

  const code = await run
  running = false
  await prober

  expect(code).toBe(0)

  // THE ASSERTION THE DEFECT FAILED. Immediately after the CLI reports
  // success, with no sleep to let anything expire: a 202 here is the reported
  // success being a lie, and every event it accepts lands in ClickHouse under
  // a project id Postgres no longer knows about.
  const after = await track()
  expect(after.status).toBe(401)
  // WHICH terminal code appears is not fixed, and pinning one would be
  // pinning the cache's contents rather than the refusal. The last probe
  // below re-cached the project WHILE it was being deleted, so this answer
  // comes back `project_deleted` out of that entry; once it ages out the
  // lookup finds no project at all and the same request answers
  // `invalid_write_key`. Both are terminal 401s and both are correct — the
  // invariant is that neither is a 202.
  expect(['project_deleted', 'invalid_write_key']).toContain(after.error)

  expect((await pg.query('SELECT id FROM projects WHERE id = $1', [projectId])).rowCount).toBe(0)

  // Past the last possible cached entry, deterministically: there is no
  // project any more, so the key resolves to nothing.
  await sleep(CACHE_TTL_MS + 500)
  const later = await track()
  expect(later.status).toBe(401)
  expect(later.error).toBe('invalid_write_key')

  // Zero rows for a project with no Postgres row is the whole invariant: a
  // non-zero count here IS the orphaned-project state. The sleep above is
  // already several flush intervals, so anything the buffer was holding has
  // had its chance to land.
  expect(await eventCount()).toBe(0)

  // The window was real: events really were accepted after the request was
  // filed, and the refusal arrived while the delete was still waiting. If
  // either stops being true the assertions above prove less than they look
  // like they do, so both are checked rather than assumed.
  expect(seen.some((r) => r.status === 202)).toBe(true)
  expect(seen.some((r) => r.status === 401 && r.error === 'project_deleted')).toBe(true)

  // Last, and least: the wait is announced rather than spent in silence.
  expect(c.errText()).toContain('before tearing down')
}, 60_000)
