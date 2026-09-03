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
 * runtime dependency of this package (see packages/cli/package.json), which
 * is what lets this file import `buildApp` and its identity-dictionary setup.
 * It used to be a devDependency, on the grounds that nothing shipped in
 * `bin/lyraflow` touched it; `seed-demo` does — it builds its rows with the
 * ingest route's own `toEventRow` and writes its bindings through the
 * server's own `IdentityBindings`, rather than growing a second copy of
 * either. Every documented way to run this CLI runs it inside the image that
 * already contains the server (`docker compose exec lyraflow node
 * packages/cli/dist/index.js …`), so nothing about the packaging changes —
 * but the dependency has to be declared for `pnpm install --prod` to keep
 * resolving it.
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
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
let WRITE_KEY: string
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

  // Every other live-database suite migrates in its own beforeAll, and this
  // one must too — not as belt and braces, but because nothing orders the
  // suites. A developer's database is always already migrated by an earlier
  // run, so a missing migration here is invisible locally and fails only on
  // a fresh database: exactly what CI has. `cleanupProject` below is the
  // first statement to touch `projects`, so it is the one that reports it.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(HERE, '..', '..', 'db', 'migrations')),
    appSchemaVersion: 999,
  })

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

  // The same output carries the write key `snippet` is meant to print — read
  // from the CLI's own printed output (create-project.ts), not re-derived
  // from Postgres, so the `snippet` test below is checking against the
  // value an operator would actually have seen.
  const writeKeyMatch = /\b(wk_[0-9a-f]+)\b/.exec(created.stdout)
  if (!writeKeyMatch?.[1]) {
    throw new Error(`could not find a write key in create-project output:\n${created.stdout}`)
  }
  WRITE_KEY = writeKeyMatch[1]

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

  it('--version reports a bad flag as exit 2 and JSON, not a stack trace', async () => {
    // Against the real binary, because the defect was in how `main` called
    // `runVersion` as much as in `runVersion` itself: the exit code was
    // never set from its result. `--version` is what the README tells an
    // agent to run first.
    const bad = await run(['--version', '--unknown-flag', '--json'])
    expect(bad.code).toBe(2)
    expect(bad.stdout).toBe('')
    expect(bad.stderr).not.toContain('UsageError')
    expect(bad.stderr).not.toMatch(/\n\s+at /)
    expect(JSON.parse(bad.stderr.trim()).code).toBe('usage_error')

    // And the ordinary path still exits 0 with the documented object.
    const good = await run(['--version', '--json'])
    expect(good.code).toBe(0)
    expect(good.stderr).toBe('')
    expect(Object.keys(JSON.parse(good.stdout.trim())).sort()).toEqual(['output_schema', 'version'])
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

  it('never prints a --host taken from argv, in any of the seven command groups, on either client failure path', async () => {
    // THE COMPOSITION NO TEST ON THIS BRANCH HAD: a sentinel in ARGV *and*
    // a real `Client`. Five separate sentinel sweeps (events.test.ts,
    // stats.test.ts, persons.test.ts, catalog.test.ts ×3) put a sentinel in
    // `--host` and asserted nothing about it, because every one of them
    // builds a FAKE client — so `#buildUrl` and `#request`, the two places
    // that interpolated `#host`, never ran at all. The one suite that drives
    // the real client (this file) only ever put the sentinel in the
    // ENVIRONMENT, where `--host`'s own value never appears. Both halves
    // passed; the leak sat in the middle, in all six groups that existed at
    // the time:
    //
    //   $ lyraflow stats --host=sk_live_SENTINEL_never_here
    //   {"error":"could not build a request URL from host
    //    \"sk_live_SENTINEL_never_here\" and path \"/v1/events/stats\"",...}
    //
    // `--host` is a raw argv value (`extractOverride`, index.ts): a secret
    // typed one slot off, or an agent templating the wrong variable, lands
    // there as easily as a URL does.
    //
    // `snippet` (the seventh group, added with that command) is a
    // deliberate exception to this sweep's own premise: on its SUCCESS path
    // it prints `ctx.host` on purpose — that is half of the command's job
    // (see snippet.ts's own module docstring). It is still safe to enumerate
    // here because BOTH failure paths below fail before `runSnippet` ever
    // renders anything at all: `invalid_url` fails building its very first
    // request (`GET /v1/project`), inside `Client#buildUrl`, and
    // `no_response` fails sending that same request, inside `Client#request`
    // — in neither case does execution ever reach the point where a
    // successful `host` would be printed.
    const secret = 'sk_live_SENTINEL_never_here'
    const groups: string[][] = [
      ['events', '--since', '1h'],
      ['stats'],
      ['persons', 'get', 'nobody'],
      ['segments', 'list'],
      ['schema', 'events'],
      ['deletions', 'get', '1'],
      ['snippet'],
    ]

    for (const argv of groups) {
      // Path 1 — `invalid_url`: the value is not a usable base URL at all,
      // so this fails inside `#buildUrl` before any socket is opened.
      const bad = await run([...argv, `--host=${secret}`, '--json'])
      expect(bad.code, `invalid_url path for ${argv[0]}`).toBe(1)
      expect(bad.stdout + bad.stderr).not.toContain(secret)
      expect(JSON.parse(bad.stderr.trim()).code).toBe('invalid_url')

      // Path 2 — `no_response`: a well-formed URL that resolves to nothing,
      // so this fails inside `#request`'s own catch instead. A different
      // message, built in a different place; the leak was in both.
      const unreachable = await run([...argv, `--host=http://${secret}.invalid:9`, '--json'])
      expect(unreachable.code, `no_response path for ${argv[0]}`).toBe(1)
      expect(unreachable.stdout + unreachable.stderr).not.toContain(secret)
      expect(JSON.parse(unreachable.stderr.trim()).code).toBe('no_response')
    }
  }, 60_000)

  it('snippet prints the write key, never the server key, with the documented --json field set, against a real server', async () => {
    // The rule this command exists around, checked at the one layer that
    // proves it against a REAL project row rather than a fixture this file
    // invented: the WRITE key (`WRITE_KEY`, read out of `create-project`'s
    // own output in `beforeAll`) is public by construction and printing it
    // is this command's entire job, so it must be present; the SERVER key
    // this CLI authenticates every request with must never appear, on the
    // one path in this whole CLI that is allowed to print A key at all.
    const { stdout, code } = await run(['snippet', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.trim())

    // Exact-set equality, not a subset: an accidentally-added field is as
    // much a contract change here as a removed one, the same standard
    // snippet.test.ts's own --json tests hold this command to.
    expect(Object.keys(parsed).sort()).toEqual(
      ['events', 'host', 'methods', 'sdk_version', 'snippet', 'write_key'].sort(),
    )

    expect(parsed.write_key).toBe(WRITE_KEY)
    expect(parsed.snippet).toContain(WRITE_KEY)
    expect(stdout).not.toContain(SERVER_KEY)

    // THE `src` THIS SNIPPET PRINTS IS A URL THIS SERVER ACTUALLY SERVES.
    // Nothing asserted that before: `snippet-bundle.test.ts` resolves the
    // printed `src` against the LOCAL dist directory (a file on disk, not a
    // route), and this file had a real server but never fetched it. Renaming
    // the route in `packages/server/src/sdk/routes.ts` would leave both
    // suites green and every emitted snippet broken — a 404 on the one tag
    // whose whole job is to load the SDK. One real GET closes it.
    const srcMatch = /<script async src="([^"]+)"><\/script>/.exec(parsed.snippet as string)
    expect(srcMatch, 'the emitted snippet has no bundle-loading <script src=…> tag').not.toBeNull()
    const src = (srcMatch as RegExpExecArray)[1] as string
    expect(src).toBe(`${HOST}/lyraflow.js`)
    const bundleRes = await fetch(src)
    expect(bundleRes.status, `${src} did not answer 200`).toBe(200)
    const body = await bundleRes.text()
    // Not merely "something answered": the body has to be the SDK bundle.
    expect(body.length).toBeGreaterThan(1000)
    expect(body).toContain('lyraflow')
  })

  it('surfaces a property-less event via events/stats when schema/events cannot see it, against real ClickHouse materialized views', async () => {
    // Ties the union fix to the DATABASE BEHAVIOUR that caused the bug it
    // fixes, not to a fake `Client`'s promise about that behaviour.
    // `event_schema` (schema/events' source) is fed by materialized views
    // keyed on `mapKeys(properties)`/`mapKeys(properties_num)`
    // (002_events.sql) — an event whose rows carry EMPTY property maps
    // produces zero rows there, structurally, no matter how many times it
    // fired. `evRow` (this file's own fixture builder, above) always sets
    // `properties: {}` and `properties_num: {}` — every fixture in this
    // suite, including `cb-baseline` (three rows, inserted in `beforeAll`),
    // is exactly this shape. `snippet.test.ts`'s own union tests assert the
    // identical claim, but only against a hand-written fake that already
    // agrees with `mergeEventCounts`' assumptions by construction; nothing
    // in this repo before this test exercised the real materialized view
    // that made the claim true in the first place. A future migration that
    // re-keyed `event_schema_str_mv`/`event_schema_num_mv` — reintroducing
    // this exact bug, or silently widening what they capture — would pass
    // every other committed test of this command and fail only here.
    const { stdout, code } = await run(['snippet', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout.trim())
    // `.events` is a UNION and this command exits 0 on the degraded arm
    // (see the CLI README's own warning to check `.events.error` first).
    // Reading `.counts` straight off it turned a degraded section into
    // `TypeError: Cannot read properties of undefined` — a failure that
    // says nothing about what actually went wrong, in place of the
    // carefully-worded assertion below.
    expect(
      parsed.events.error,
      'the events section degraded, so this test never reached the claim it exists to make',
    ).toBeUndefined()
    expect(
      parsed.events.partial,
      'one informational request failed, so the union this test checks was never formed from both sources',
    ).toBeUndefined()
    const baseline = (parsed.events.counts as { event_name: string; count: number }[]).find(
      (c) => c.event_name === 'cb-baseline',
    )
    expect(
      baseline,
      'cb-baseline (property-less in every fixture row) should surface via events/stats even though schema/events has never seen it',
    ).toBeDefined()
    expect(baseline?.count).toBe(3)
  })

  it('still says which setting to fix when --host is unusable, without repeating what was passed', async () => {
    // Redacting must not cost the diagnostic — the same standard the
    // `--limit` redaction was held to. The flag and the environment
    // variable are both named; only the value is gone.
    const { stderr } = await run(['stats', '--host=not-a-url', '--json'])
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.error).toContain('--host')
    expect(parsed.error).toContain('LYRAFLOW_HOST')
    expect(parsed.error).not.toContain('not-a-url')
  })

  /** A stub host that answers every request `200 application/json` with one
   * fixed body. The real server this file boots always answers correctly,
   * so it cannot produce the case below — but an auth proxy's interstitial,
   * a load balancer's JSON error page, or `LYRAFLOW_HOST` pointed one host
   * off all can, and all of them are ordinary for a self-hosted product
   * whose host is user-supplied. */
  async function hostAnswering(body: string): Promise<{ url: string; close: () => Promise<void> }> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('stub host has no port')
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('reports a wrong-shaped 2xx body as {error, code} with exit 1, never a raw stack trace', async () => {
    // Before this, all five list commands died on `records.length` (or, for
    // a `null` body, one property read earlier still) with a raw TypeError
    // and a Node stack trace on stderr — under `--json`, where the contract
    // promises {error, code}. Three layers were each correct alone: the
    // client guaranteed only "the body is JSON", the command modules'
    // TypeScript interfaces are erased at runtime, and output.ts had been
    // hardened against hostile values INSIDE the record list but never
    // against the list itself. Fixed in two of those three (client.ts's
    // #readJson now requires an object; output.ts's emitRecords requires a
    // list) — deliberately NOT by adding per-command field validation,
    // which would be a second hand-written copy of the server's contract
    // for six response shapes, free to drift from the first.
    const commands: string[][] = [
      ['events', '--since', '1h'],
      ['stats'],
      ['segments', 'list'],
      ['schema', 'events'],
      ['schema', 'properties'],
    ]
    for (const body of ['{}', 'null', '[]', '"hello"']) {
      const host = await hostAnswering(body)
      try {
        for (const argv of commands) {
          const result = await run([...argv, '--json'], { host: host.url })
          const where = `${argv.join(' ')} against body ${body}`
          expect(result.code, where).toBe(1)
          expect(result.stdout, where).toBe('')
          expect(result.stderr, where).not.toContain('TypeError')
          expect(result.stderr, where).not.toMatch(/\n\s+at /)
          const parsed = JSON.parse(result.stderr.trim())
          expect(typeof parsed.error).toBe('string')
          expect(['invalid_response_body', 'invalid_response_shape']).toContain(parsed.code)
        }
      } finally {
        await host.close()
      }
    }
  }, 60_000)

  it('does NOT invent fields a wrong-shaped 2xx object is missing — the deliberate edge of the fix', async () => {
    // Pinning the boundary rather than leaving it to be rediscovered. The
    // guarantee is "a wrong-shaped body never crashes, and never silently
    // becomes an empty record list"; it is NOT "every documented field is
    // validated". A `{}` body to a single-record command is therefore
    // printed as `{}` with exit 0 — honest output of what the server
    // actually sent, and visible to an agent as a missing field, rather
    // than a per-command validator mirroring six response shapes.
    const host = await hostAnswering('{}')
    try {
      const result = await run(['persons', 'get', 'nobody', '--json'], { host: host.url })
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('{}')

      // A `null` body to the same command IS refused, because "there is no
      // record here at all" is a failed request answered with a 200.
      const nullHost = await hostAnswering('null')
      try {
        const nullResult = await run(['persons', 'get', 'nobody', '--json'], { host: nullHost.url })
        expect(nullResult.code).toBe(1)
        expect(JSON.parse(nullResult.stderr.trim()).code).toBe('invalid_response_body')
      } finally {
        await nullHost.close()
      }
    } finally {
      await host.close()
    }
  }, 20_000)

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

  it('--follow exits 0 and writes a resume cursor on a real SIGINT, against a real server', async () => {
    // The Critical a Task 10 review caught: the module docstring on
    // events.ts's "cancelled sleep" catch names "an AbortController wired to
    // SIGINT by the real dispatch" as the intended caller, and a UNIT test
    // with an injected, rejecting `sleep` proved that catch branch worked —
    // but nothing in the real dispatch (index.ts) ever actually wired a
    // signal to it. A real `SIGINT` against the built binary fell straight
    // through to Node's own default handling: killed with no exit code at
    // all (a shell reports 130) and no resume cursor ever written. This test
    // sends a REAL signal to a REAL subprocess — an injected/fake `sleep`
    // cannot prove this the way `runSIGKILL` above cannot stand in for it
    // either; see index.ts's `abortableSleep`/`wireFollowInterrupt` for the
    // fix this pins.
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--event', FOLLOW_EVENT_NAME, '--json'],
      {
        env: { ...process.env, LYRAFLOW_HOST: HOST, LYRAFLOW_SERVER_KEY: SERVER_KEY },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // At least one full poll cycle before interrupting — the fixture
    // already has events in this window from earlier tests in this file, so
    // the first (cursorless) poll should produce output almost immediately;
    // this just gives it a moment to settle into its steady `sleep` state,
    // which is the state the fix actually targets (see abortableSleep's own
    // "known gap" note for the in-flight-request case this does NOT cover).
    await new Promise((resolve) => setTimeout(resolve, 500))

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
      },
    )
    child.kill('SIGINT')

    const { code, signal } = await closed

    expect(signal).toBeNull()
    expect(code).toBe(0)

    const resumeLine = stderr
      .trim()
      .split('\n')
      .find((line) => line.includes('next_cursor'))
    expect(resumeLine).toBeDefined()
    const parsed = JSON.parse(resumeLine as string)
    expect(typeof parsed.next_cursor).toBe('string')
    expect(parsed.next_cursor.length).toBeGreaterThan(0)

    // stdout is real NDJSON throughout — the interrupt must not corrupt the
    // record stream it already wrote.
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  }, 15_000)

  /**
   * A stub host that answers the FIRST poll with a well-formed events page
   * — so the follow loop really does hold a cursor — and then accepts every
   * later request and never answers it. That is the state a `--follow`
   * session is in for almost all of its life (2s of sleep per poll, an open
   * request the rest of the time), and it is the one state the real server
   * this file boots cannot be made to produce, because it always answers.
   * Same precedent as the blackhole address the non-follow signal test
   * below already uses for the same reason.
   */
  async function hangingAfterFirstPoll(eventCount = 1): Promise<{
    url: string
    pollInFlight: Promise<void>
    close: () => Promise<void>
  }> {
    let polls = 0
    let arrived: () => void = () => {}
    const pollInFlight = new Promise<void>((resolve) => {
      arrived = resolve
    })
    // Padded so a page of them cannot fit in a 64 KiB pipe buffer — the
    // flush tests below depend on the child genuinely having a backlog,
    // not on winning a race.
    const events = Array.from({ length: eventCount }, (_, i) => ({
      event_id: `stub-${String(i).padStart(6, '0')}`,
      timestamp: '2026-08-09T00:00:00.000Z',
      anonymous_id: 'a'.repeat(400),
      url: 'u'.repeat(400),
    }))
    const server: Server = createServer((_req, res) => {
      polls += 1
      if (polls === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        // Real events, not an empty page: the loop only adopts a cursor
        // when a poll actually returned events (events.ts keys on what it
        // observed, not on `next_cursor` alone), and a session with no
        // cursor could not prove the cursor survives the interrupt.
        res.end(JSON.stringify({ events, next_cursor: 'CURSOR-FROM-FIRST-POLL' }))
        return
      }
      arrived() // accepted, deliberately never answered
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('stub host has no port')
    return {
      url: `http://127.0.0.1:${address.port}`,
      pollInFlight,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`--follow exits promptly on ONE ${sig} arriving while a poll is still in flight`, async () => {
      // The Critical the final whole-branch review found, and the exact
      // shape the two tests either side of this one structurally could not
      // see: one covers a signal during the SLEEP, the other a signal
      // during a request on a command with no --follow. Nothing covered a
      // signal during a REQUEST under --follow — which is where a follow
      // session spends most of its life.
      //
      // Installing a signal listener suppresses Node's own default kill.
      // The listener used to only `controller.abort()`, and the loop was
      // awaiting `client.get`, not `ctx.sleep` — so the signal was consumed
      // and DISCARDED. Measured before the fix, against a host that accepts
      // the connection and never answers: SIGINT alone, SIGINT→SIGTERM and
      // SIGTERM→SIGINT all survived past 8 seconds (bounded by undici's
      // 301-second headersTimeout) and had to be SIGKILLed, losing the
      // resume cursor that was the point of wiring signals at all.
      //
      // "It exits" is not the property. "It exits promptly, on the FIRST
      // signal, having written the cursor" is — hence the elapsed-time
      // assertion below, which is what a passing-but-worthless version of
      // this test would fail.
      const host = await hangingAfterFirstPoll()
      const child = spawn(
        process.execPath,
        [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--json'],
        {
          env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => resolve({ code, signal }))
        },
      )

      try {
        // Not a fixed sleep: wait until the second poll has genuinely
        // reached the stub and is sitting there unanswered. A timing guess
        // here could signal during the sleep instead and silently test the
        // case the other test already covers.
        await host.pollInFlight

        const sentAt = Date.now()
        child.kill(sig)
        const { code, signal } = await closed
        const elapsed = Date.now() - sentAt

        // `signal: null` is what proves the process ended through its own
        // handler rather than a default kill; `code: 0` is the documented
        // contract for an interrupted tail (see packages/cli/README.md).
        expect(signal).toBeNull()
        expect(code).toBe(0)
        // Generous by three orders of magnitude against the 301s the bug
        // allowed, and still far below the 2s poll interval — so this can
        // only pass if the exit did not wait for the in-flight request.
        expect(elapsed).toBeLessThan(1000)

        // The cursor from the first poll must survive the interrupt: it is
        // the whole reason a follow session gets a signal handler at all,
        // and it is written from inside the signal handler, so an
        // implementation that queued it on an async stderr pipe would lose
        // it here.
        const resumeLine = stderr
          .trim()
          .split('\n')
          .find((line) => line.includes('next_cursor'))
        expect(resumeLine).toBeDefined()
        expect(JSON.parse(resumeLine as string)).toEqual({
          next_cursor: 'CURSOR-FROM-FIRST-POLL',
        })

        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          expect(() => JSON.parse(line)).not.toThrow()
        }
      } finally {
        child.kill('SIGKILL')
        await host.close()
      }
    }, 20_000)
  }

  it('an interrupt does not drop records stdout has not flushed yet', async () => {
    // THE REGRESSION THE FIRST VERSION OF THE SIGNAL FIX INTRODUCED, found
    // by asking what the fix broke rather than whether it worked.
    // `process.exit` discards whatever `process.stdout` still has buffered,
    // and on POSIX stdout is ASYNCHRONOUS when it is a pipe — which is how
    // every agent harness runs this CLI. Measured with this exact fixture
    // before the flush was added: 148 of 500 records delivered, exit 0, and
    // a resume cursor positioned after the 352 that never arrived, so
    // `--after` would skip them forever. Silent loss reported as success,
    // in the command whose stated promise is "no event twice, none missed".
    //
    // The reader here does not start consuming until AFTER the signal, so
    // the backlog is guaranteed rather than raced: 500 padded records is
    // several hundred KiB against a 64 KiB pipe buffer.
    const RECORDS = 500
    const host = await hangingAfterFirstPoll(RECORDS)
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--limit', String(RECORDS), '--json'],
      {
        env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const closed = new Promise<{ code: number | null }>((resolve) => {
      child.on('close', (code) => resolve({ code }))
    })

    try {
      await host.pollInFlight

      let stdout = ''
      child.kill('SIGINT')
      // Only now does anything read stdout. Everything the child wrote is
      // sitting in the pipe and in its own stream buffer.
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      const { code } = await closed
      expect(code).toBe(0)

      const lines = stdout.trim().split('\n').filter(Boolean)
      expect(lines.length).toBe(RECORDS)
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
      expect(JSON.parse(lines[0] as string).event_id).toBe('stub-000000')
      expect(JSON.parse(lines[RECORDS - 1] as string).event_id).toBe('stub-000499')

      // Nothing was truncated, so the cursor is trustworthy and the
      // truncation warning must NOT have been written.
      expect(stderr).not.toContain('may not have reached the reader')
      expect(stderr).toContain('CURSOR-FROM-FIRST-POLL')
    } finally {
      child.kill('SIGKILL')
      await host.close()
    }
  }, 30_000)

  it('says so, and still exits, when a reader that never reads makes the flush time out', async () => {
    // The other side of that fix: waiting for stdout must not become a new
    // way to hang, so the wait is bounded — and when the bound is hit the
    // truncation is REPORTED, immediately before the cursor it invalidates,
    // rather than left to look like a clean exit 0. This reader never
    // consumes a byte.
    const host = await hangingAfterFirstPoll(500)
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--limit', '500', '--json'],
      {
        env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
      },
    )

    try {
      await host.pollInFlight
      const sentAt = Date.now()
      child.kill('SIGINT')
      const { code, signal } = await closed
      const elapsed = Date.now() - sentAt

      expect(signal).toBeNull()
      expect(code).toBe(0)
      // Bounded: one signal is still enough, even here. The grace is 2s;
      // this proves it is neither ignored nor unbounded.
      expect(elapsed).toBeGreaterThanOrEqual(1500)
      expect(elapsed).toBeLessThan(6000)

      const lines = stderr.trim().split('\n').filter(Boolean)
      const warningAt = lines.findIndex((l) => l.includes('may not have reached the reader'))
      const cursorAt = lines.findIndex((l) => l.includes('CURSOR-FROM-FIRST-POLL'))
      expect(warningAt).toBeGreaterThanOrEqual(0)
      expect(cursorAt).toBeGreaterThan(warningAt)
      expect(() => JSON.parse(lines[warningAt] as string)).not.toThrow()
    } finally {
      child.kill('SIGKILL')
      await host.close()
    }
  }, 30_000)

  /**
   * Runs an interrupted `--follow` with stdout AND stderr on the SAME pipe
   * (`2>&1`), pre-filled by this test so that exactly `tailRoom` bytes are
   * free in its tail page when the interrupt writes its trailing lines.
   *
   * Controlling that number is the whole point, and it cannot be done by
   * letting the CLI fill the pipe itself: once the record stream has a
   * backlog Node coalesces it with `writev`, whose partial writes fill the
   * pipe to exactly full every time, so the interesting remainders never
   * occur by chance. Pre-filling makes the one variable that decides the
   * outcome an input.
   */
  async function interruptWithTailRoom(tailRoom: number): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'lyraflow-fifo-'))
    const fifo = join(dir, 'merged')
    execFileSync('mkfifo', [fifo])
    // O_RDWR so opening does not block waiting for the other end.
    const fd = openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
    try {
      const page = Buffer.alloc(4096, 0x2e)
      page[4095] = 0x0a // newline-terminated filler, so lines stay separable
      for (let i = 0; i < 15; i++) writeSync(fd, page, 0, 4096)
      writeSync(fd, page, 0, 4096 - tailRoom)

      const host = await hangingAfterFirstPoll(1)
      const child = spawn(
        '/bin/sh',
        [
          '-c',
          `exec "$0" "$@" > ${fifo} 2>&1`,
          process.execPath,
          CLI_ENTRY,
          'events',
          '--follow',
          '--since',
          '15m',
          '--json',
        ],
        {
          env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
          stdio: ['ignore', 'ignore', 'ignore'],
        },
      )
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
      try {
        await host.pollInFlight
        child.kill('SIGINT')
        await exited
      } finally {
        child.kill('SIGKILL')
        await host.close()
      }

      let drained = ''
      for (;;) {
        const buf = Buffer.alloc(65536)
        let read = 0
        try {
          read = readSync(fd, buf, 0, 65536, null)
        } catch {
          break // EAGAIN — nothing left
        }
        if (read === 0) break
        drained += buf.subarray(0, read).toString()
        if (drained.length > 400_000) break
      }
      return drained
    } finally {
      closeSync(fd)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('never writes the resume cursor without its truncation warning, even on one shared pipe', async () => {
    // `2>&1` — a documented run shape, what agent harnesses routinely do,
    // and what the README's own worked example shows. The two lines used to
    // be two separate `writeSync` calls, which on a congested pipe have
    // INDEPENDENT fates: POSIX makes a write of at most PIPE_BUF (4096)
    // bytes to a pipe atomic, so with R bytes of room the 149-byte warning
    // fails EAGAIN entirely while the 21-byte cursor still fits — and the
    // survivor is the one that is dangerous alone. A cursor with no warning
    // says "resume from here" about records that never arrived; `--after`
    // then skips them permanently, which is the exact failure the flush was
    // added to prevent.
    //
    // Measured with two writes, before the fix, at 40/100/148 bytes of tail
    // room: BARE CURSOR every time. One write of the two lines together
    // (170 bytes, still under PIPE_BUF) can only land or fail as a unit.
    const CURSOR = '{"next_cursor"'
    const WARNING = 'may not have reached the reader'

    // Room for the cursor alone (21B) but not for both lines (170B) — the
    // window in which the old code emitted the dangerous half.
    const tight = await interruptWithTailRoom(100)
    expect(tight).not.toContain(CURSOR)
    expect(tight.includes(CURSOR) && !tight.includes(WARNING)).toBe(false)

    // Control: with room for both, both are there — so the assertion above
    // is about fate-sharing, not about the CLI having stopped reporting.
    const roomy = await interruptWithTailRoom(400)
    expect(roomy).toContain(WARNING)
    expect(roomy).toContain(CURSOR)
    expect(roomy.indexOf(WARNING)).toBeLessThan(roomy.indexOf(CURSOR))
  }, 30_000)

  it('writes the resume cursor exactly once when the signal lands during the sleep with a backlog', async () => {
    // The follow loop's own cancelled-sleep catch writes the cursor, and so
    // does the interrupt handler — so both fired and stderr carried
    // `next_cursor` twice, against a documented "one JSON object per line"
    // contract where a consumer reading "the" cursor now finds two. It is
    // invisible without a backlog, because with nothing pending the process
    // exits synchronously inside the signal handler before the loop's catch
    // ever runs; a slow reader opens exactly that window. `ctx.writeErr` is
    // now inert from the instant of the signal, so the interrupt's snapshot
    // is the single authority.
    const host = await hangingAfterFirstPoll(500)
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--limit', '500', '--json'],
      {
        env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }))
    })

    try {
      // Deliberately NOT `pollInFlight`: this needs the signal to land while
      // the loop is in its 2s sleep between polls, which is the only state
      // in which the loop's own catch can run and duplicate the line.
      await new Promise((resolve) => setTimeout(resolve, 400))
      child.kill('SIGINT')
      const { code } = await exited
      expect(code).toBe(0)

      const cursorLines = stderr
        .split('\n')
        .filter((line) => line.trimStart().startsWith('{"next_cursor"'))
      expect(cursorLines).toHaveLength(1)
      expect(JSON.parse(cursorLines[0] as string)).toEqual({
        next_cursor: 'CURSOR-FROM-FIRST-POLL',
      })
    } finally {
      child.kill('SIGKILL')
      await host.close()
    }
  }, 30_000)

  /**
   * A stub host whose SECOND poll answers part-way through the flush grace,
   * with a different cursor — the one window in which the follow loop can
   * still advance its own state after a signal has already been handled.
   * Every other stub in this file either answers immediately or never, and
   * neither can produce it.
   */
  async function answersSecondPollDuringGrace(opts: {
    firstPollEvents: number
    secondPollAfterMs: number
  }): Promise<{ url: string; secondPollInFlight: Promise<void>; close: () => Promise<void> }> {
    let polls = 0
    let arrived: () => void = () => {}
    const secondPollInFlight = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const timers: ReturnType<typeof setTimeout>[] = []
    const padded = (id: string) => ({
      event_id: id,
      timestamp: '2026-08-09T00:00:00.000Z',
      anonymous_id: 'a'.repeat(400),
      url: 'u'.repeat(400),
    })
    const server: Server = createServer((_req, res) => {
      polls += 1
      if (polls === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            events: Array.from({ length: opts.firstPollEvents }, (_, i) =>
              padded(`first-${String(i).padStart(6, '0')}`),
            ),
            next_cursor: 'CURSOR-AT-SIGNAL-TIME',
          }),
        )
        return
      }
      if (polls === 2) {
        arrived()
        timers.push(
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                events: [padded('during-grace-000000')],
                next_cursor: 'CURSOR-ADVANCED-DURING-GRACE',
              }),
            )
          }, opts.secondPollAfterMs),
        )
        return
      }
      // Anything after that: accepted, never answered.
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('stub host has no port')
    return {
      url: `http://127.0.0.1:${address.port}`,
      secondPollInFlight,
      close: () =>
        new Promise<void>((resolve) => {
          for (const timer of timers) clearTimeout(timer)
          server.close(() => resolve())
        }),
    }
  }

  it('reports the cursor as it stood at the signal, not one the loop advanced to during the grace', async () => {
    // The snapshot half of the interrupt fix, which had no guard: mutating
    // the handlers to read at EXIT time instead of at signal time passed all
    // 23 tests, because every other stub in this file either answers a poll
    // immediately or never answers at all. Neither can put a response INSIDE
    // the flush grace, which is the only window where the loop can still
    // advance its own cursor after a signal has been handled.
    //
    // What goes wrong without it: the second poll's records are not written
    // (output belongs to the interrupt from the instant of the signal) and
    // would not have been flushed even if they were — the reader here never
    // reads — yet `cursor` in the loop has already moved past them. A
    // cursor read at exit time therefore says "resume after a record that
    // was never delivered", and `--after` skips it permanently. That is the
    // bare-cursor defect in a third disguise, which is why it is pinned
    // here rather than left to the argument in the docstring.
    const host = await answersSecondPollDuringGrace({
      firstPollEvents: 500,
      secondPollAfterMs: 800, // comfortably inside the 2s grace
    })
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'events', '--follow', '--since', '15m', '--limit', '500', '--json'],
      {
        env: { ...process.env, LYRAFLOW_HOST: host.url, LYRAFLOW_SERVER_KEY: 'sk_stub' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }))
    })

    try {
      // stdout is deliberately never read: that is what creates the backlog,
      // and the backlog is what creates a grace window long enough for the
      // second poll to land inside it.
      await host.secondPollInFlight
      const sentAt = Date.now()
      child.kill('SIGINT')
      const { code } = await exited
      const elapsed = Date.now() - sentAt

      expect(code).toBe(0)
      // The grace really did run — otherwise the window this test exists to
      // cover never opened and the assertions below would pass vacuously.
      expect(elapsed).toBeGreaterThanOrEqual(1500)
      expect(stderr).toContain('may not have reached the reader')

      const cursorLines = stderr
        .split('\n')
        .filter((line) => line.trimStart().startsWith('{"next_cursor"'))
      expect(cursorLines).toHaveLength(1)
      expect(JSON.parse(cursorLines[0] as string)).toEqual({
        next_cursor: 'CURSOR-AT-SIGNAL-TIME',
      })
      expect(stderr).not.toContain('CURSOR-ADVANCED-DURING-GRACE')
    } finally {
      child.kill('SIGKILL')
      await host.close()
    }
  }, 30_000)

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    it(`a non-follow command still dies on ${sig} the ordinary way, not held open by the follow fix`, async () => {
      // The other half of the same review finding: wireFollowInterrupt
      // (index.ts) installs a SIGINT/SIGTERM listener ONLY when `--follow` is
      // present in argv, specifically so every other invocation keeps Node's
      // own default signal handling (an immediate, uncatchable kill)
      // untouched. Pointed at an address that accepts a TCP connection and
      // never answers, so the request is still genuinely in flight when the
      // signal arrives — a fast-failing host would prove nothing here. If a
      // future change widened the wiring to every command, this request would
      // instead exit 0 (or hang) once whatever it's awaiting eventually
      // settles, rather than dying on the signal the way a plain `events`
      // call always has. Both signals, not only SIGINT: the follow fix makes
      // one of them end the process with code 0, so "the default is intact"
      // has to be checked for each of them separately.
      const child = spawn(process.execPath, [CLI_ENTRY, 'events', '--since', '15m', '--json'], {
        env: {
          ...process.env,
          // A non-routable address that a connection attempt blackholes
          // against rather than refuses — the request hangs instead of
          // failing fast, which is what this test needs. Port 9999, NOT a
          // low/"unsafe" port (e.g. 1): undici's fetch refuses those
          // synchronously (the same list a browser's `fetch` honours), which
          // made an earlier version of this test fail for the wrong reason —
          // the request never even started, so there was nothing for the
          // signal to interrupt.
          LYRAFLOW_HOST: 'http://10.255.255.1:9999',
          LYRAFLOW_SERVER_KEY: 'sk_test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on('close', (code, signal) => resolve({ code, signal }))
        },
      )

      await new Promise((resolve) => setTimeout(resolve, 500))
      child.kill(sig)

      const { code, signal } = await closed
      expect(signal).toBe(sig)
      expect(code).toBeNull()
    }, 10_000)
  }
})

/** Sibling of `runCli` above, for the one command in this file that reads
 * its secret from stdin rather than an argument — `runCli` closes stdin
 * immediately (`stdio: ['ignore', …]`), which would make this command block
 * forever waiting for input that will never arrive. */
function runCliWithStdin(
  argv: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end(stdin)
  })
}

describe('reset-admin-login', () => {
  const DB_ENV = {
    ...process.env,
    LYRAFLOW_POSTGRES_URL: PG_URL,
    LYRAFLOW_CLICKHOUSE_URL: CH_CONFIG.url,
    LYRAFLOW_CLICKHOUSE_USER: CH_CONFIG.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH_CONFIG.password,
    LYRAFLOW_CLICKHOUSE_DB: CH_CONFIG.database,
  }

  it('is set-admin-password under another name: it replaces the email and the password', async () => {
    await pg.query('DELETE FROM admin_user')
    await pg.query("INSERT INTO admin_user (email, password_hash) VALUES ('old@example.com', 'x')")

    const res = await runCliWithStdin(
      ['reset-admin-login', 'new@example.com', '--json'],
      'a-new-password\n',
      DB_ENV,
    )

    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({
      command: 'set-admin-password',
      email: 'new@example.com',
      outcome: 'updated',
    })
    const rows = await pg.query<{ email: string }>('SELECT email FROM admin_user')
    expect(rows.rows.map((r) => r.email)).toEqual(['new@example.com'])
    await pg.query('DELETE FROM admin_user')
  })
})
