/**
 * Drives the BUILT CLI (`dist/index.js`) as a real subprocess against a
 * real Fastify server, listening on a real ephemeral TCP port, and real
 * Postgres/ClickHouse — the one place a documented `--json` field, an exit
 * code, and the "never print the key" guarantee are all checked against
 * what actually happens when an agent runs `lyraflow events --json`, not
 * against a function call or a hand-built fake. See index.epipe.test.ts's
 * own docstring for why importing the module directly, or a fake HTTP
 * server, cannot stand in for this — and Plan 6's shipped-but-unusable SDK
 * snippet, which every function-level test passed while the artefact itself
 * never worked, for why this class of test exists at all.
 *
 * The SERVER side is booted the same way packages/server/src/events/
 * routes.test.ts and packages/server/src/privacy/read-paths.test.ts boot
 * it — `buildApp` called in-process, with `ensureIdentityDictionaries`
 * pointed at Postgres via the compose network's OWN hostname
 * (`postgres:5432`), not `localhost:5433` — deliberately, NOT run as a
 * second spawned subprocess: this repo's dev/test topology runs this test
 * process (and, if it were spawned the same way, the server) OUTSIDE
 * Docker, reaching Postgres/ClickHouse via host-mapped ports, while
 * ClickHouse itself lives INSIDE the compose network and can only resolve
 * Postgres by the compose service name. Confirmed the hard way: pointing a
 * really-spawned `packages/server/dist/index.js` at
 * `LYRAFLOW_POSTGRES_URL=postgres://...@localhost:5433/...` — the only
 * address reachable from THIS process — makes the server itself boot fine,
 * but every `/v1/events` request then fails with a generic 503 the moment a
 * per-row `dictGet` tries to lazily connect Postgres from ClickHouse's own
 * container, where `localhost` is ClickHouse itself: `Connection to
 * localhost:5433 failed ... Connection refused`. `buildApp` in-process,
 * with the dictionaries created against the address ClickHouse can actually
 * reach, is what every other live-database suite in this repo already does
 * for exactly this reason — this file follows that precedent rather than
 * inventing a second, subtly broken one. The CLI side is still the real,
 * built `dist/index.js`, run as a genuine OS subprocess — that half of the
 * artefact gap is what this task exists to close, and it does not depend on
 * how the server happens to be hosted.
 *
 * Requires `pnpm build` to have already produced `dist/index.js` for
 * packages/cli (this repo's own convention — see the root CLAUDE.md), and a
 * real Postgres (5433) + ClickHouse (8123) reachable at the same addresses
 * every other live-database suite in this repo uses. `packages/server` is a
 * devDependency of this package (see packages/cli/package.json) purely so
 * this one file can import `buildApp` and its identity-dictionary setup —
 * nothing shipped in `bin/lyraflow` touches it.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ClickHouseClient, type Pool, createChClient, createPgPool } from '@lyraflow/db'
import { buildApp } from '@lyraflow/server/dist/app.js'
import { loadConfig } from '@lyraflow/server/dist/config.js'
import { Readiness } from '@lyraflow/server/dist/health.js'
import {
  type PgDictionarySource,
  ensureIdentityDictionaries,
} from '@lyraflow/server/dist/identity/dictionaries.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(HERE, '..', 'dist', 'index.js')

const CH_DB = 'lyraflow_test'
const CH_CONFIG = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const PG_URL = `postgres://lyraflow:lyraflow@localhost:5433/${CH_DB}`

// Resolved by the ClickHouse *server* itself, inside the compose network —
// same pattern as events/routes.test.ts, privacy/read-paths.test.ts and
// every other live-database suite in this repo. See the module docstring
// for why this must NOT be `localhost:5433`.
const PG_SOURCE: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const pg: Pool = createPgPool(PG_URL)
const ch: ClickHouseClient = createChClient(CH_CONFIG)

// Already lowercase, alnum-and-hyphen only, so `slugify` (create-project.ts)
// is the identity function on it — this doubles as the project's slug,
// letting cleanup look it up directly with no need to reimplement that
// function here. Own prefix, distinct from every other live-database
// suite's own fixture ids in this repo (events/routes.test.ts's 77/79
// event_id prefixes, its own SLUG_A/SLUG_B) so a standalone run of this
// file can never collide with rows a different suite left behind.
const PROJECT_NAME = 'cli-binary-test'

const uuid = (n: number) => `cb000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const FOLLOW_EVENT_NAME = 'cb-follow-probe'
const EXPORT_USER = 'cb-export-user'

let app: ReturnType<typeof buildApp>
let HOST: string
let SERVER_KEY: string
let PROJECT_ID: number

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Spawns the built CLI with a fully explicit environment — no reliance on
 * `run`'s LYRAFLOW_HOST/LYRAFLOW_SERVER_KEY defaults — for the one caller
 * (project setup) that needs Postgres/ClickHouse env vars instead. */
function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

/** The everyday helper every test below uses: the built CLI against the
 * real, already-booted server, with `host`/`serverKey` overridable per call
 * (the wrong-key and never-leaks tests need that). */
function run(argv: string[], opts: { host?: string; serverKey?: string } = {}): Promise<RunResult> {
  return runCli(argv, {
    ...process.env,
    LYRAFLOW_HOST: opts.host ?? HOST,
    LYRAFLOW_SERVER_KEY: opts.serverKey ?? SERVER_KEY,
  })
}

interface EvOpts {
  eventId: string
  eventName: string
  userId?: string
  anonymousId?: string
  atMs: number
}

function evRow(opts: EvOpts) {
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
  return {
    project_id: PROJECT_ID,
    event_id: opts.eventId,
    anonymous_id: opts.anonymousId ?? '',
    user_id: opts.userId ?? '',
    event_name: opts.eventName,
    timestamp: fmt(opts.atMs),
    received_at: fmt(opts.atMs),
    trusted: 1,
    properties: {},
    properties_num: {},
  }
}

async function insertEvents(rows: ReturnType<typeof evRow>[]): Promise<void> {
  await ch.insert({ table: 'events', format: 'JSONEachRow', values: rows })
}

/** Run at the TOP of beforeAll, not only in afterAll — per the branch's
 * live-database rule, so a previous crashed run can never leave a project
 * this run's `create-project` (which refuses to run against a duplicate
 * slug) trips over. */
async function cleanupProject(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
    PROJECT_NAME,
  ])
  const id = existing.rows[0] ? Number(existing.rows[0].id) : undefined
  if (id === undefined) return
  await ch.command({
    query: `ALTER TABLE events DELETE WHERE project_id = ${id}`,
    clickhouse_settings: { mutations_sync: '1' },
  })
  await pg.query('DELETE FROM projects WHERE id = $1', [id])
}

beforeAll(async () => {
  expect(
    existsSync(CLI_ENTRY),
    `${CLI_ENTRY} is missing — run pnpm build first (packages/cli)`,
  ).toBe(true)

  await cleanupProject()

  // Seeded through the built CLI itself, not a direct INSERT — this is the
  // real path an operator uses to get a server key at all, and it also
  // exercises `create-project` as a real subprocess for free. Only the
  // Postgres/ClickHouse env vars are needed; this subcommand never reads
  // LYRAFLOW_HOST/LYRAFLOW_SERVER_KEY.
  const created = await runCli(['create-project', PROJECT_NAME], {
    ...process.env,
    LYRAFLOW_POSTGRES_URL: PG_URL,
    LYRAFLOW_CLICKHOUSE_URL: CH_CONFIG.url,
    LYRAFLOW_CLICKHOUSE_USER: CH_CONFIG.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH_CONFIG.password,
    LYRAFLOW_CLICKHOUSE_DB: CH_CONFIG.database,
  })
  if (created.code !== 0) {
    throw new Error(
      `create-project failed (code ${created.code}):\n${created.stdout}\n${created.stderr}`,
    )
  }
  const serverKeyMatch = /\b(sk_[0-9a-f]+)\b/.exec(created.stdout)
  if (!serverKeyMatch?.[1]) {
    throw new Error(`could not find a server key in create-project output:\n${created.stdout}`)
  }
  SERVER_KEY = serverKeyMatch[1]

  const projectRow = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
    PROJECT_NAME,
  ])
  const row = projectRow.rows[0]
  if (!row) throw new Error('project row not found immediately after create-project')
  PROJECT_ID = Number(row.id)

  await ensureIdentityDictionaries(ch, PG_SOURCE)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: PG_URL,
    LYRAFLOW_CLICKHOUSE_URL: CH_CONFIG.url,
    LYRAFLOW_CLICKHOUSE_USER: CH_CONFIG.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH_CONFIG.password,
    LYRAFLOW_CLICKHOUSE_DB: CH_CONFIG.database,
  } as NodeJS.ProcessEnv)

  const readiness = new Readiness()
  readiness.markReady()
  // `app.ts` reads this directly from `process.env` rather than `Config` —
  // silenced so this file's own request/response log lines (this test binds
  // a real listening socket, unlike routes.test.ts's `app.inject`) don't
  // drown out `pnpm test`'s output. Only set if the caller hasn't already
  // chosen a level.
  process.env.LYRAFLOW_LOG_LEVEL ??= 'silent'
  app = buildApp({ config, pg, ch, readiness })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('app has no usable listening address')
  }
  HOST = `http://127.0.0.1:${address.port}`

  const now = Date.now()

  // ---- Baseline fixture: what the generic NDJSON/field-set/human tests
  // read. Three events, well inside any --since 1h/15m window. ----
  await insertEvents([
    evRow({
      eventId: uuid(1),
      eventName: 'cb-baseline',
      anonymousId: 'cb-anon-1',
      atMs: now - 30_000,
    }),
    evRow({
      eventId: uuid(2),
      eventName: 'cb-baseline',
      anonymousId: 'cb-anon-1',
      atMs: now - 20_000,
    }),
    evRow({
      eventId: uuid(3),
      eventName: 'cb-baseline',
      anonymousId: 'cb-anon-1',
      atMs: now - 10_000,
    }),
  ])

  // ---- Export fixture: two events for one identified user, read back
  // byte-for-byte by the `persons export` test. ----
  await insertEvents([
    evRow({ eventId: uuid(60), eventName: 'cb-export', userId: EXPORT_USER, atMs: now - 40_000 }),
    evRow({ eventId: uuid(61), eventName: 'cb-export', userId: EXPORT_USER, atMs: now - 35_000 }),
  ])

  // ---- Follow fixture: one event now, seeding the --follow test's first
  // poll. A second event is inserted mid-test, after the process has
  // already started following. ----
  await insertEvents([
    evRow({
      eventId: uuid(50),
      eventName: FOLLOW_EVENT_NAME,
      anonymousId: 'cb-follow-anon',
      atMs: now - 5_000,
    }),
  ])
}, 60_000)

afterAll(async () => {
  // `app` (and everything after it in beforeAll) never ran if the missing-
  // build guard, or anything earlier in setup, threw — an `undefined.close()`
  // here would mask that original failure behind a second, less useful one.
  await app?.close()
  await cleanupProject()
  await pg.end()
  await ch.close()
})

// The CLI is subprocess-run; the server is not — it is buildApp() in this
// process, for the reason the module docstring above sets out. Naming it
// otherwise would put a false claim in every CI line and failure message
// this file emits, in the one file whose whole job is stopping tests from
// claiming more than they do.
describe('the built CLI against a real, in-process server', () => {
  it('prints NDJSON when its output is a pipe', async () => {
    // A subprocess's stdout is a pipe, so this exercises the real detection
    // rather than a mocked isTty.
    const { stdout, code } = await run(['events', '--since', '1h'])
    expect(code).toBe(0)
    const lines = stdout.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('exits 2 on a usage error and writes nothing to stdout', async () => {
    const { stdout, stderr, code } = await run(['events', '--since', 'bad'])
    expect(code).toBe(2)
    expect(stdout).toBe('')
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.code).toBe('usage_error')
  })

  it('exits 1 with a json error object when the key is wrong', async () => {
    const { stdout, stderr, code } = await run(['events', '--since', '1h'], {
      serverKey: 'sk_0000000000000000000000000000000000000000000000',
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.code).toBe('invalid_server_key')
  })

  it('emits exactly the documented fields on an event record', async () => {
    // THE contract test. `--json` is a promised interface, and a promise with
    // no test is a promise that decays — this is the one place a real record
    // from a real server passes through the real binary, so it is where the
    // field set can actually be pinned. Verified directly against
    // packages/server/src/events/routes.ts's FeedRow/response mapping, not
    // copied from the task brief unchecked.
    //
    // Exact set equality, not a subset: a field silently ADDED is as much a
    // contract change as one removed, and an agent that starts depending on
    // an accidental field is worse off than one that never saw it.
    const { stdout, code } = await run(['events', '--since', '1h', '--limit', '1'])
    expect(code).toBe(0)
    const record = JSON.parse(stdout.trim().split('\n')[0] as string)
    expect(Object.keys(record).sort()).toEqual(
      [
        'anonymous_id',
        'browser',
        'city',
        'country',
        'device_type',
        'event_id',
        'event_name',
        'os',
        'path',
        'properties',
        'properties_num',
        'referrer',
        'region',
        'timestamp',
        'url',
        'user_id',
        'utm_campaign',
        'utm_content',
        'utm_medium',
        'utm_source',
        'utm_term',
      ].sort(),
    )
  })

  it('never prints the server key, on any path', async () => {
    // Including the failure paths, which are where a careless error message
    // would put it — and a success path too (a leak is not only ever an
    // error-message bug).
    const argvs: string[][] = [
      ['events'],
      ['events', '--since', 'bad'],
      ['persons', 'get', 'nobody'],
      ['persons', 'export', 'definitely-not-a-real-person'],
      ['events', '--since', '1h', '--human'],
    ]
    for (const argv of argvs) {
      const { stdout, stderr } = await run(argv, { serverKey: SERVER_KEY })
      expect(stdout + stderr).not.toContain(SERVER_KEY)
    }

    // `not.toContain` also passes when nothing was printed at all, and four
    // of the five shapes above are failure paths where empty output is
    // plausible. Assert the success path actually produced something, so
    // this cannot decay into a test that proves silence.
    const { stdout } = await run(['events', '--since', '1h'], { serverKey: SERVER_KEY })
    expect(stdout).not.toBe('')
    expect(stdout).not.toContain(SERVER_KEY)
  })

  it('honours --human at a non-tty, in the direction detection alone would get wrong', async () => {
    // A subprocess's stdout is a pipe, so detection alone would pick json —
    // --human must win over that, not merely agree with a tty-backed test.
    const { stdout, code } = await run(['events', '--since', '1h', '--limit', '1', '--human'])
    expect(code).toBe(0)
    const lines = stdout.trim().split('\n').filter(Boolean)
    // Header + exactly one row, given --limit 1 and a fixture with at least
    // one event in the window.
    expect(lines.length).toBe(2)
    expect(() => JSON.parse(lines[0] as string)).toThrow()
    expect(lines[0]).toContain('event_name')
    expect(lines[0]).toContain('timestamp')
  })

  it('passes a person export through byte-for-byte, terminator included', async () => {
    const { stdout, code } = await run(['persons', 'export', EXPORT_USER])
    expect(code).toBe(0)
    const lines = stdout.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2 + 2) // person + 2 events + end

    const person = JSON.parse(lines[0] as string)
    expect(person.type).toBe('person')
    expect(person.person_id).toBe(EXPORT_USER)

    const last = JSON.parse(lines[lines.length - 1] as string)
    expect(last).toEqual({ type: 'end', events: 2 })

    const eventLines = lines.slice(1, -1).map((l) => JSON.parse(l))
    for (const e of eventLines) expect(e.type).toBe('event')
    expect(eventLines.map((e) => e.event_id).sort()).toEqual([uuid(60), uuid(61)].sort())
  })

  it('exits 0 instead of crashing when the reader closes the pipe before the child ever writes, against the real server', async () => {
    // index.epipe.test.ts already proves this against a hand-built fake
    // HTTP server; this is the same failure mode against the real server
    // this file boots, at the one call site (`events`) the brief's tests
    // all run against.
    const child = spawn(process.execPath, [CLI_ENTRY, 'events', '--since', '1h'], {
      env: { ...process.env, LYRAFLOW_HOST: HOST, LYRAFLOW_SERVER_KEY: SERVER_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('error', () => {})
    child.stdout.destroy()

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code))
    })

    expect(exitCode).toBe(0)
    expect(stderr).not.toMatch(/Unhandled|Emitted 'error' event|at afterWriteDispatched/)
  }, 15_000)

  it('--follow polls for new events without repeating or missing any, against a real server', async () => {
    // No subprocess test has ever driven --follow before this one — every
    // earlier events.ts test either calls runEvents() directly with a fake
    // ctx.sleep, or (index.epipe.test.ts) never passes --follow at all.
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--event', FOLLOW_EVENT_NAME],
      {
        env: { ...process.env, LYRAFLOW_HOST: HOST, LYRAFLOW_SERVER_KEY: SERVER_KEY },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let buffer = ''
    const seenLines: string[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        if (line.trim()) seenLines.push(line)
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
      }
    })

    function waitForCount(n: number, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs
      return new Promise((resolve, reject) => {
        const check = () => {
          if (seenLines.length >= n) return resolve()
          if (Date.now() > deadline) {
            return reject(new Error(`only saw ${seenLines.length} record(s) after ${timeoutMs}ms`))
          }
          setTimeout(check, 100)
        }
        check()
      })
    }

    try {
      // First poll: the event seeded before this test started.
      await waitForCount(1, 10_000)
      const first = JSON.parse(seenLines[0] as string)
      expect(first.event_id).toBe(uuid(50))

      // Insert a second event mid-session — the shape a real --follow
      // session is meant to pick up on its NEXT poll (FOLLOW_POLL_MS is
      // 2000ms; a comfortable multiple of that as the wait budget).
      await insertEvents([
        evRow({
          eventId: uuid(51),
          eventName: FOLLOW_EVENT_NAME,
          anonymousId: 'cb-follow-anon',
          atMs: Date.now(),
        }),
      ])

      await waitForCount(2, 10_000)
      expect(seenLines.length).toBe(2)
      const second = JSON.parse(seenLines[1] as string)
      expect(second.event_id).toBe(uuid(51))
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)
})
