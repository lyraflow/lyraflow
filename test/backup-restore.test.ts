import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The test drives Docker directly with `-f`, but every *script* it invokes is
// given COMPOSE_FILE instead and no `-f` at all — see runScript. That is the
// assertion, not a convenience: docker-compose.yml is present in this
// directory and its stack is not running, so a backup.sh that ignored
// COMPOSE_FILE would talk to the wrong (or to no) stack and fail validation.
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', 'docker-compose.ci.yml', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  })

const BASE = 'http://localhost:3000'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36'
const CH_BACKUP_DIR = '/var/lib/clickhouse/backups'

let writeKey: string
/** The project's secret key — the deletion route is the only user of it here. */
let serverKey: string
/** A destination no user, including root, can create a directory under. */
let unwritableDestination: string

const SCRIPT_ENV = { ...process.env, COMPOSE_FILE: 'docker-compose.ci.yml' }

/**
 * A directory containing a `docker` that forwards to the real one, used to
 * reproduce failures that are genuinely reachable but cannot be arranged from
 * outside the script.
 *
 * Deliberately a *test* fixture rather than an environment variable the script
 * reads: production code that exists only so a test can steer it is code an
 * operator can trip over. A PATH shim steers nothing — `backup.sh` is byte-for
 * -byte the shipped script and simply happens to find a different `docker`.
 */
let shimDir: string

function runScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): string {
  return execFileSync(script, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...SCRIPT_ENV, ...env },
    // `input: undefined` is NOT the same as omitting it: execFileSync treats
    // the presence of the key as "use a pipe for stdin and close it", which is
    // what backup.sh already gets. Spelled out because restore.sh's
    // confirmation reads stdin, and a test that meant to type nothing and a
    // test that meant to inherit the runner's stdin must not look alike.
    ...(input === undefined ? {} : { input }),
  })
}

/**
 * The same thing without blocking the event loop.
 *
 * `execFileSync`/`spawnSync` block Node entirely for the duration, so ANY test
 * that needs to do something WHILE a script runs — put load on the app, watch
 * for a state change — has to use this instead. That is not a style
 * preference: a load generator written as an async loop beside an
 * `execFileSync` call never issues a single request, and the test then passes
 * against the defect it was written to catch.
 */
function runScriptAsync(
  script: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { env: { ...SCRIPT_ENV, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(input)
  })
}

/**
 * Runs a script that is expected to exit non-zero and returns its stderr.
 * Fails loudly if it succeeds — a silently-passing "expected to throw" test is
 * exactly the shape that hides a regression here.
 */
function runScriptExpectingFailure(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): string {
  try {
    runScript(script, args, env, input)
  } catch (e) {
    const err = e as { stderr?: Buffer | string }
    return String(err.stderr ?? '')
  }
  throw new Error(`${script} ${args.join(' ')} unexpectedly succeeded`)
}

/** Environment that makes the shimmed `docker` behave a particular way. */
const withShim = (vars: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  PATH: `${shimDir}:${process.env.PATH}`,
  ...vars,
})

/**
 * A single scalar from ClickHouse over HTTP — no build artefacts required.
 *
 * Retries a CONNECTION failure and nothing else, for the same reason
 * readyStatus() does: undici keeps sockets alive between requests, a restore
 * takes the best part of a minute, and the first query after one reuses a
 * socket ClickHouse's own keep-alive timeout has already closed. That surfaces
 * as UND_ERR_SOCKET before a request is ever sent, which is a property of the
 * HTTP client. An HTTP error — the store answering with a complaint — is not
 * retried, because that is a real answer.
 */
async function chScalar(sql: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch('http://localhost:8123/?database=lyraflow', {
        method: 'POST',
        headers: { 'x-clickhouse-user': 'lyraflow', 'x-clickhouse-key': 'lyraflow' },
        body: sql,
      })
    } catch (e) {
      if (attempt >= 2) throw e
      await new Promise((r) => setTimeout(r, 500))
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`)
    return text.trim()
  }
}

const pgScalar = (sql: string): string =>
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'lyraflow',
    '-d',
    'lyraflow',
    '-At',
    '-c',
    sql,
  ).trim()

function parseManifest(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line === '') continue
    const eq = line.indexOf('=')
    expect(eq, `manifest line is not key=value: ${line}`).toBeGreaterThan(0)
    out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

const sha256OfFile = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

const mode = (path: string): number => statSync(path).mode & 0o777

/** Runs a successful backup into a fresh directory and returns the stamp dir. */
function takeBackup(): string {
  const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
  runScript('./backup.sh', [dest])
  const stamps = readdirSync(dest)
  expect(stamps).toHaveLength(1)
  return join(dest, stamps[0] as string)
}

const manifestTimestamp = (out: string): string =>
  parseManifest(join(out, 'MANIFEST')).timestamp as string

/** The confirmation restore.sh asks for, as it arrives on stdin. */
const confirmation = (out: string): string => `${manifestTimestamp(out)}\n`

/**
 * Rewrites one manifest key in place. Safe to use for guard tests because the
 * manifest is not itself checksummed — only clickhouse.zip and postgres.dump
 * are — so a rewritten key reaches the guard it is aimed at rather than being
 * caught by the checksum guard first.
 */
function rewriteManifestKey(path: string, key: string, value: string): void {
  const lines = readFileSync(path, 'utf8').split('\n')
  let found = false
  const next = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line
    found = true
    return `${key}=${value}`
  })
  expect(found, `no ${key} in ${path}`).toBe(true)
  writeFileSync(path, next.join('\n'))
}

/** Removes every manifest line whose key starts with `prefix`. */
function dropManifestKeys(path: string, prefix: string): void {
  const lines = readFileSync(path, 'utf8').split('\n')
  const next = lines.filter((line) => !line.startsWith(prefix))
  expect(next.length, `no ${prefix}* lines in ${path}`).toBeLessThan(lines.length)
  writeFileSync(path, next.join('\n'))
}

function truncateFile(path: string, bytes: number): void {
  const fd = openSync(path, 'r+')
  try {
    ftruncateSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

/**
 * Name, size, mode and checksum of everything in a backup directory.
 *
 * A restore reads a backup and must not write to it — an operator's only copy
 * of their data is not scratch space, and a restore that scribbles in it turns
 * one bad restore into no more attempts.
 */
const fingerprint = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .map((f) => {
      const p = join(dir, f)
      return `${f} ${statSync(p).size} ${mode(p).toString(8)} ${sha256OfFile(p)}`
    })

/**
 * The app container's start time.
 *
 * `/ready` answering 200 is NOT evidence a guard refused before stopping the
 * app: both scripts restart it on the way out and wait for health first, so a
 * guard that ran too late looks identical from outside. This does not — it
 * moves if and only if the container was actually restarted.
 */
const appStartedAt = (): string =>
  execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.StartedAt}}', compose('ps', '-aq', 'lyraflow').trim()],
    { encoding: 'utf8' },
  ).trim()

/** The same stamp format backup.sh computes with `date -u +%Y-%m-%dT%H%M%SZ`. */
function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function backupsDirListing(): string {
  return compose('exec', '-T', 'clickhouse', 'ls', CH_BACKUP_DIR)
}

/**
 * `/ready`'s status, tolerating a dead pooled socket but nothing else.
 *
 * undici keeps connections alive between requests, and every backup in this
 * file stops and starts the app container underneath them. The first fetch
 * after a restart therefore reuses a socket the departed container already
 * closed and fails with UND_ERR_SOCKET before a request is ever sent — which
 * is a property of the HTTP client, not of the app. Three attempts 500ms apart
 * covers that and nothing else: backup.sh does not return until the container
 * reports healthy, so a genuinely-down app still fails all three.
 */
async function readyStatus(): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await fetch(`${BASE}/ready`)).status
    } catch (e) {
      if (attempt >= 2) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

async function waitReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/ready`)).ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('Lyraflow did not become ready in time')
}

const ingestHeaders = () => ({
  'content-type': 'application/json',
  'x-lyraflow-write-key': writeKey,
  // A browser user-agent, and not optional: isBot() treats a missing UA — and
  // any UA containing `curl/` — as a bot, and a bot payload is answered 202 and
  // then silently discarded. Without this the fixture below never arrives and
  // every row count in the manifest is zero, which still matches /^\d+$/.
  'user-agent': UA,
})

beforeAll(async () => {
  // Same reason as the sibling durability files: volumes survive `down`, so a
  // previous run that died before afterAll would leave a duplicate project
  // slug and stale archives on the backups disk behind.
  compose('down', '-v')
  // `--build`, not a bare `up`: this stack's image is named, so Compose reuses
  // whatever is already tagged and never notices the working tree has moved on
  // — a stack that was silently running an image three days and five
  // migrations behind the checkout.
  compose('up', '-d', '--build', '--wait')
  await waitReady()

  const out = compose(
    'exec',
    '-T',
    'lyraflow',
    'node',
    'packages/cli/dist/index.js',
    'create-project',
    'Backups',
  )
  writeKey = /wk_[a-f0-9]+/.exec(out)?.[0] as string
  expect(writeKey).toBeTruthy()
  serverKey = /sk_[a-f0-9]+/.exec(out)?.[0] as string
  expect(serverKey).toBeTruthy()

  // A fixture with rows in it, so the manifest's counts describe something.
  // Repeated anonymous_ids on purpose: device_index and person_traits are
  // AggregatingMergeTree and collapse rows sharing a sorting key on merge, so
  // this is what makes the merge-stable count expression load-bearing rather
  // than decorative.
  for (let i = 0; i < 6; i++) {
    const anon = `backup-anon-${i % 2}`
    await fetch(`${BASE}/v1/track`, {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({
        message_id: randomUUID(),
        anonymous_id: anon,
        event: `backup_event_${i % 2}`,
        properties: { plan: 'pro', seats: i },
      }),
    })
    await fetch(`${BASE}/v1/identify`, {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({
        message_id: randomUUID(),
        anonymous_id: anon,
        user_id: `backup-person-${i % 2}`,
        traits: { tier: 'gold', mrr: i },
      }),
    })
  }
  // The ingest buffer flushes on a timer; give it room so the counts the
  // manifest records are not a race against LYRAFLOW_FLUSH_INTERVAL_MS.
  await new Promise((r) => setTimeout(r, 5000))

  // ONE PERSON EXERCISES THEIR RIGHT TO ERASURE, through the real route.
  //
  // Not decoration. `suppressed_persons` is the table the entire
  // ClickHouse-before-Postgres argument exists to protect, and until this
  // existed the fixture never wrote a row to it — so `liveState().suppressed`
  // was the string '0' in every assertion in this file, and a mutation that
  // dropped the whole table from verification could not be seen. A row here is
  // never removed, including after the purge (005_suppression.sql), which is
  // exactly what makes it survive into every backup this suite takes.
  const erased = await fetch(`${BASE}/v1/persons/backup-person-1`, {
    method: 'DELETE',
    headers: { 'x-lyraflow-server-key': serverKey },
  })
  expect([200, 202]).toContain(erased.status)

  // WAIT FOR THE PURGE TO FINISH, and this is not politeness. The purge runs
  // asynchronously and deletes that person's events from ClickHouse; a purge
  // that lands in the middle of a later test moves `rows.clickhouse.events`
  // between a manifest and the count taken against it, or between the two
  // halves of `expectRefusal`. Every count in this file has to be taken after
  // it, so the fixture blocks until `completed_at` is set.
  const purgeDeadline = Date.now() + 120_000
  while (Date.now() < purgeDeadline) {
    if (
      pgScalar('SELECT count(*) FROM public.deletion_requests WHERE completed_at IS NULL') === '0'
    )
      break
    await new Promise((r) => setTimeout(r, 1000))
  }
  expect(
    pgScalar('SELECT count(*) FROM public.deletion_requests WHERE completed_at IS NULL'),
    'the purge did not finish; every row count in this file would be racing it',
  ).toBe('0')
  expect(
    Number(pgScalar('SELECT count(*) FROM public.suppressed_persons')),
    'the erasure fixture did not produce a suppression row',
  ).toBeGreaterThan(0)
  // The buffer may have flushed again while the purge ran.
  await new Promise((r) => setTimeout(r, 5000))

  // mkdir(2) under a *regular file* fails with ENOTDIR for every user
  // including root, which a mode-0500 directory does not — this suite runs as
  // root in some environments, where chmod-based unwritability is invisible.
  const dir = mkdtempSync(join(tmpdir(), 'lyraflow-unwritable-'))
  writeFileSync(join(dir, 'afile'), 'not a directory\n')
  unwritableDestination = join(dir, 'afile', 'backups')

  // The `docker` shim. SHIM_FAIL_BEFORE makes a matching invocation fail
  // without running; SHIM_FAIL_AFTER runs it for real and *then* reports
  // failure — which is the shape of Ctrl-C during `docker compose stop`, where
  // the container really does stop and the command still exits non-zero.
  shimDir = mkdtempSync(join(tmpdir(), 'lyraflow-shim-'))
  const realDocker = execFileSync('sh', ['-c', 'command -v docker'], {
    encoding: 'utf8',
  }).trim()
  const shimBody = [
    '#!/bin/sh',
    // The match includes the program name, so one shim body serves both
    // `docker` and `rm` and the existing docker match strings still hit.
    'SELF=$(basename "$0")',
    'if [ -n "${SHIM_FAIL_BEFORE:-}" ]; then',
    '  case "$SELF $*" in *"$SHIM_FAIL_BEFORE"*) exit 1 ;; esac',
    'fi',
    'if [ -n "${SHIM_FAIL_BEFORE2:-}" ]; then',
    '  case "$SELF $*" in *"$SHIM_FAIL_BEFORE2"*) exit 1 ;; esac',
    'fi',
    // SHIM_FAIL_ONCE fails the first matching invocation and lets every later
    // one through, which is the shape of a transient failure — a deferred
    // signal landing on one command — and therefore the shape a retry can
    // actually recover from.
    'if [ -n "${SHIM_FAIL_ONCE:-}" ]; then',
    '  case "$SELF $*" in',
    '    *"$SHIM_FAIL_ONCE"*)',
    '      if [ ! -f "$SHIM_MARKER" ]; then : > "$SHIM_MARKER"; exit 1; fi',
    '      ;;',
    '  esac',
    'fi',
    'if [ -n "${SHIM_FAIL_AFTER:-}" ]; then',
    `  case "$SELF $*" in *"$SHIM_FAIL_AFTER"*) "$REAL_BIN" "$@"; exit 1 ;; esac`,
    'fi',
    // SHIM_KILL_BEFORE signals the script that invoked it and never runs the
    // real command — the shape of `timeout`, systemd stopping a unit, a
    // supervisor, a CI cancel or a plain `kill`, parked at a chosen
    // statement. $PPID is the shell running the script, because the shim is
    // its direct child.
    'if [ -n "${SHIM_KILL_BEFORE:-}" ]; then',
    '  case "$SELF $*" in',
    '    *"$SHIM_KILL_BEFORE"*)',
    '      kill -TERM "$PPID"',
    '      exit 143',
    '      ;;',
    '  esac',
    'fi',
    'exec "$REAL_BIN" "$@"',
    '',
  ]

  // One shim body, installed as every binary the scripts call that a cleanup
  // step depends on. `rm` is here so a cleanup step that is NOT a docker
  // command can be made to fail too — see the cleanup-robustness test.
  for (const [name, real] of [
    ['docker', realDocker],
    ['rm', execFileSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).trim()],
  ] as const) {
    writeFileSync(
      join(shimDir, name),
      shimBody.join('\n').replace('$REAL_BIN', real).replace('$REAL_BIN', real),
      { mode: 0o755 },
    )
  }
}, 600_000)

afterAll(() => {
  compose('down', '-v')
})

describe('backup.sh', () => {
  it('writes exactly the three expected files and a parseable manifest', async () => {
    const out = takeBackup()
    expect(readdirSync(out).sort()).toEqual(['MANIFEST', 'clickhouse.zip', 'postgres.dump'])

    const m = parseManifest(join(out, 'MANIFEST'))
    expect(m.lyraflow_backup_version).toBe('1')
    expect(m.mode).toBe('quiesced')
    expect(m.timestamp).toBe(basename(out))
    expect(m.schema_version).toMatch(/^\d+$/)
    expect(m.app_image).toBeTruthy()
    expect(m.clickhouse_image).toBe('clickhouse/clickhouse-server:24.8-alpine')
    expect(m.postgres_image).toBe('postgres:17-alpine')
    expect(m['rows.clickhouse.events']).toMatch(/^\d+$/)
    expect(Number(m['rows.clickhouse.events'])).toBeGreaterThan(0)

    // The tables are enumerated from the database, not hardcoded. Asserting a
    // table that no fixture in this file touches — and that only exists
    // because a migration created it — is what distinguishes "enumerated" from
    // "happens to list the tables the test uses".
    expect(m['rows.clickhouse.events_dead_letter']).toMatch(/^\d+$/)
    expect(m['rows.postgres.schema_migrations']).toMatch(/^\d+$/)
    expect(m['rows.postgres.projects']).toMatch(/^\d+$/)

    // Materialized views and dictionaries are not storage; counting them would
    // double-count their target table or force a dictionary load from Postgres
    // during the quiesce.
    expect(m['rows.clickhouse.device_index_mv']).toBeUndefined()
    expect(m['rows.clickhouse.identity_bindings']).toBeUndefined()
    // Postgres views likewise: a dictionary source view is a windowed
    // projection of a table already counted, so its count is partly a function
    // of the wall clock.
    expect(m['rows.postgres.identity_bindings_dict_src']).toBeUndefined()

    // A table-level TTL is recorded, because a TTL'd table's count falls on its
    // own and a restore of a backup older than the retention window would
    // otherwise read as data loss. Measured on a scale model with the window
    // shortened to 20s: manifest 10, count immediately after RESTORE 10, count
    // once the window passed 0. Only the tables that have one get the key, so
    // its presence is the signal Task 3 reads.
    expect(m['rowttl.clickhouse.events_dead_letter']).toBe(
      'toDateTime(received_at) + toIntervalDay(30)',
    )
    expect(m['rowttl.clickhouse.events']).toBeUndefined()
    expect(m['rowttl.clickhouse.device_index']).toBeUndefined()

    // Every count in the manifest must name the expression it was taken with,
    // because `count()` is not stable across BACKUP/RESTORE for the merging
    // engines — measured, see ch_count_expression. Without this, restore.sh
    // has no way to compare like with like and would have to fall back to a
    // tolerance.
    expect(m['rowexpr.clickhouse.device_index']).toBe('count() FINAL')
    expect(m['rowexpr.clickhouse.person_traits']).toBe('count() FINAL')
    expect(m['rowexpr.clickhouse.events']).toBe('count() FINAL')
    expect(m['rowexpr.clickhouse.event_schema']).toBe('count() FINAL')
    // …and a plain MergeTree must NOT get FINAL: ClickHouse rejects it with
    // Code 181, ILLEGAL_FINAL, which would fail the backup outright.
    expect(m['rowexpr.clickhouse.events_dead_letter']).toBe('count()')

    // Sorted, so a diff between two manifests is readable.
    const keys = readFileSync(join(out, 'MANIFEST'), 'utf8').trim().split('\n')
    expect(keys).toEqual([...keys].sort())
  }, 300_000)

  it('records row counts that match the databases, table by table', async () => {
    // Until this existed, every row count in the manifest was asserted only as
    // /^\d+$/ with a single `> 0` — so a manifest reporting every Postgres
    // table as 0, or counting every ClickHouse table from `events`, passed the
    // whole suite. Those numbers are the entire basis of Tasks 3 and 4's
    // verification, which makes "it is a number" far too weak a claim.
    //
    // Each count is re-taken with the expression the manifest itself names, so
    // this compares like with like rather than re-deriving the merge-stability
    // rule here and drifting from it.
    const out = takeBackup()
    const m = parseManifest(join(out, 'MANIFEST'))

    // The SET of tables, derived from the databases rather than written down
    // here. A table quietly missing from the manifest used to survive the whole
    // suite: adding `AND table_name NOT IN (…)` to pg_row_counts passed 14/14,
    // because only four named Postgres tables were ever checked and never their
    // membership. That is reachable without a code change —
    // information_schema.tables only shows relations the connecting role holds
    // a privilege on — and `suppressed_persons` silently vanishing is the one
    // that matters.
    const chTables = Object.keys(m)
      .filter((k) => k.startsWith('rows.clickhouse.'))
      .map((k) => k.slice('rows.clickhouse.'.length))
    const chExpected = (
      await chScalar(
        "SELECT name FROM system.tables WHERE database = 'lyraflow'" +
          " AND engine NOT IN ('MaterializedView','View','Dictionary') ORDER BY name",
      )
    ).split('\n')
    expect(chTables.sort()).toEqual(chExpected)

    const pgTables = Object.keys(m)
      .filter((k) => k.startsWith('rows.postgres.'))
      .map((k) => k.slice('rows.postgres.'.length))
    const pgExpected = pgScalar(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'" +
        " AND table_type = 'BASE TABLE' ORDER BY table_name",
    ).split('\n')
    expect(pgTables.sort()).toEqual(pgExpected)

    // Two canaries no fixture in this file touches, named explicitly so the
    // derived comparisons above cannot both drift into agreeing on an empty
    // set.
    expect(chExpected).toContain('events_dead_letter')
    expect(pgExpected).toContain('suppressed_persons')

    for (const t of chTables) {
      const expr = m[`rowexpr.clickhouse.${t}`] as string
      const final = expr.endsWith('FINAL') ? ' FINAL' : ''
      expect(await chScalar(`SELECT count() FROM \`${t}\`${final}`), t).toBe(
        m[`rows.clickhouse.${t}`],
      )
    }

    for (const t of ['projects', 'schema_migrations', 'identity_bindings', 'api_keys']) {
      expect(pgScalar(`SELECT count(*) FROM public.${t}`), t).toBe(m[`rows.postgres.${t}`])
    }

    // Two counts that are non-zero and unequal, so neither "report everything
    // as 0" nor "report every table's count as some other table's" can survive
    // the comparisons above by coincidence.
    expect(Number(m['rows.postgres.schema_migrations'])).toBeGreaterThan(0)
    expect(Number(m['rows.clickhouse.events'])).toBeGreaterThan(0)
    expect(m['rows.clickhouse.events']).not.toBe(m['rows.clickhouse.device_index'])
  }, 300_000)

  it('creates the backup directory and every file owner-only', async () => {
    // Not tidiness. The ClickHouse archive embeds the Postgres password three
    // times, in the DDL of the identity dictionaries — `SHOW CREATE
    // DICTIONARY` masks it as PASSWORD '[HIDDEN]' but the metadata inside the
    // archive does not. A permission that is not tested is a permission a
    // later refactor silently loosens, and `docker compose cp` already loosens
    // it once (it reproduces the container's 0640 and ignores umask).
    const out = takeBackup()
    expect(mode(out)).toBe(0o700)
    for (const f of ['MANIFEST', 'clickhouse.zip', 'postgres.dump']) {
      expect(mode(join(out, f)), `${f} must be owner-only`).toBe(0o600)
    }
  }, 300_000)

  it('gets those modes from a umask, not from a chmod afterwards', () => {
    // The test above pins the end state. The requirement is about the *window*:
    // `umask 022` plus a `chmod 600` after each write produces identical final
    // modes while leaving an interval in which the file exists, already holds
    // the Postgres password, and is still world-readable. That interval is not
    // observable from outside without polling, and a poll can legitimately miss
    // it — a test that passes while the defect is present is worse than no
    // test. (A watcher polling stat() continuously through a real run never
    // caught anything but the final modes on any of the four objects.)
    //
    // So the mechanism is pinned instead of the symptom, which is deterministic:
    // there is a umask, and there is no chmod anywhere to undo it.
    // Comment lines are stripped first: both files *discuss* chmod at length,
    // and the prohibition is on running one.
    // Comment lines AND here-document bodies are stripped: both are data. The
    // usage text says "<destination-directory>", which is not a redirection.
    const code = (f: string): string => {
      const out: string[] = []
      let terminator: string | null = null
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (terminator !== null) {
          if (line.trim() === terminator) terminator = null
          continue
        }
        if (/^\s*#/.test(line)) continue
        const here = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(line)
        if (here) terminator = here[1] as string
        out.push(line)
      }
      // A `<<` inside an ordinary string sets a terminator that is never found,
      // and every line after it is silently discarded — which would blind all
      // three static rules below at once while they still report cleanly.
      expect(terminator, `unterminated heredoc swallowed the rest of ${f}`).toBeNull()
      const stripped = out.join('\n')
      // The null check above only catches an UNterminated heredoc. A stray
      // `<< EOF` is closed by usage()'s own EOF, so the terminator ends null
      // while everything between them silently vanishes. Landmarks at both ends
      // of each file prove the region survived.
      for (const landmark of f === 'backup.sh'
        ? ['usage()', 'cleanup()', 'trap cleanup EXIT']
        : ['say()', 'artefact_write()', 'write_manifest()']) {
        expect(stripped, `${landmark} vanished from ${f} — a heredoc ate it`).toContain(landmark)
      }
      return stripped
    }

    // Ban the BEHAVIOUR, not one spelling of it. Banning `chmod` alone is
    // defeatable, and both of these were proven to pass a full 14-test run:
    //   `docker compose cp` + `install -m 600` — leaves the copy at 0640,
    //      holding all three PASSWORD clauses, for the length of the copy;
    //   umask relaxed inside a subshell, mode restored with `install` — leaves
    //      postgres.dump world-readable for the entire dump.
    // The first is exactly the refactor the source comment warns about:
    // someone prefers `cp`, sees this test go red, and silences it.
    const LATE_MODE_CHANGE = /\b(chmod|chown|setfacl|install)\b|--preserve|\bcp\s+-\w*p/
    for (const f of ['backup.sh', 'backup-lib.sh']) {
      expect(code(f), `${f} must not fix modes up after the fact`).not.toMatch(LATE_MODE_CHANGE)
    }

    // Exactly one umask, and it is the strict one — so it cannot be relaxed
    // for a subshell and restored afterwards.
    const script = code('backup.sh')
    const umasks = script.match(/umask\s+\S+/g) ?? []
    expect(umasks).toEqual(['umask 077'])
    expect(code('backup-lib.sh')).not.toMatch(/umask/)

    // At the top level and before the first function definition, not merely
    // before the first creator *textually*: `harden_file_mode() { umask 077; }`
    // defined early and called late satisfies a position check while `mkdir
    // "$OUT"` has already run unprotected.
    const umaskLine = script.split('\n').findIndex((l) => l === 'umask 077')
    expect(umaskLine, 'umask 077 must be an unindented top-level statement').toBeGreaterThan(-1)
    const firstFunction = script.split('\n').findIndex((l) => /^\w[\w_]*\(\)\s*\{/.test(l))
    expect(umaskLine).toBeLessThan(firstFunction)
    // …and still before the first thing that can create something.
    const creator = script.search(/(^|\s)(mkdir\b|>)/m)
    expect(creator, 'no redirect or mkdir found in backup.sh').toBeGreaterThan(-1)
    expect(script.indexOf('umask 077')).toBeLessThan(creator)

    // THE CHOKEPOINT. Exactly one redirect in either script writes data; every
    // other `>` is a diagnostic (`>&2`) or a discard (`>/dev/null`). This is
    // exhaustive over the shell's own way of creating a file, so it is not a
    // vocabulary rule that the next refactor can step around — there is only
    // one construct and it has one permitted instance.
    const dataRedirects: string[] = []
    for (const f of ['backup.sh', 'backup-lib.sh']) {
      for (const line of code(f).split('\n')) {
        const stripped = line.replace(/\d?>\s*&\s*\d/g, '').replace(/\d?>\s*\/dev\/null/g, '')
        if (stripped.includes('>')) dataRedirects.push(`${f}: ${line.trim()}`)
      }
    }
    expect(dataRedirects).toEqual(['backup-lib.sh: cat > "$1"'])

    // …and the one docker subcommand that materialises a host file, banned
    // statically as well as at runtime. The runtime audit only sees paths that
    // execute, and a `docker compose cp` FALLBACK — reached only when the
    // normal copy fails — produced clickhouse.zip at 0640 from code that
    // otherwise passed every test.
    for (const f of ['backup.sh', 'backup-lib.sh']) {
      expect(code(f), `${f} must not use docker cp`).not.toMatch(/docker\s+(compose\s+)?cp\b/)
    }

    // …and that ban only matches the unquoted spelling, so it is not the
    // mechanism — `docker compose "cp"` walks through it. The mechanism is the
    // invocation count in the runtime audit, plus this: `docker` may only be
    // invoked from an explicit set of places. A `docker "cp"` smuggled into
    // sha256_of's macOS branch — a path no audit run executes — fails here
    // whatever it is called, because sha256_of is not allowed to talk to docker
    // at all.
    const DOCKER_CALLERS = [
      'ch_query',
      'pg_query',
      'pg_dump_to',
      'copy_ch_artefact_to',
      'service_running',
      'service_image',
      'wait_until_healthy',
      'start_app_if_stopped',
      'remove_in_container_artefact',
    ]
    const libLines = code('backup-lib.sh').split('\n')
    let currentFn = ''
    for (const line of libLines) {
      const def = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/.exec(line)
      if (def) currentFn = def[1] as string
      if (!/(^|[^A-Za-z_])docker\s/.test(line)) continue
      expect(
        DOCKER_CALLERS,
        `docker is invoked from ${currentFn || '(top level)'}, which is not one of the functions allowed to`,
      ).toContain(currentFn)
    }

    // The two copy functions must each invoke docker exactly once, so a
    // fallback cannot be added beside the chokepoint call.
    for (const fn of ['copy_ch_artefact_to', 'pg_dump_to']) {
      const at = code('backup-lib.sh').indexOf(`${fn}() {`)
      expect(at, `${fn} not found`).toBeGreaterThan(-1)
      const body = code('backup-lib.sh').slice(at, code('backup-lib.sh').indexOf('\n}', at))
      expect(
        (body.match(/(^|[^A-Za-z_])docker\s/g) ?? []).length,
        `${fn} must call docker once`,
      ).toBe(1)
      expect((body.match(/artefact_write/g) ?? []).length, `${fn} must write once`).toBe(1)
    }
  })

  it('runs no command that could create a file outside the chokepoint', async () => {
    // The source rules above are exhaustive over shell redirection but say
    // nothing about a *program* that creates a file: `install`, `touch`, `tee`,
    // `dd`, and above all `docker compose cp`, which is how the last defeat
    // staged the archive through a 0640 scratch file. Enumerating those was the
    // losing game.
    //
    // So this inverts it, and does so behaviourally: bash's own xtrace reports
    // every command it actually executes, with arguments expanded, and the set
    // of them must be a subset of what these scripts are allowed to run. A new
    // way to make a file cannot be introduced without appearing here, whatever
    // it is called. `docker` is allowed, so its subcommand is audited too —
    // `cp` is the one docker subcommand that writes to the host filesystem.
    //
    // Coverage is what a runtime audit costs: it sees only the paths taken. It
    // is therefore run over both a successful backup and a failed one, which
    // together cover every line that writes an artefact.
    const ALLOWED = new Set([
      // shell builtins and keywords
      '[',
      '.',
      'case',
      'cd',
      'command',
      'echo',
      'exit',
      'for',
      'local',
      'printf',
      'pwd',
      'read',
      'return',
      'set',
      'shift',
      'sleep',
      'trap',
      'umask',
      // external programs
      'awk',
      'cat',
      'date',
      'dirname',
      'docker',
      'grep',
      'head',
      'mkdir',
      'mv',
      'rm',
      'rmdir',
      'sort',
      // Added for the durability fix: `sync` before the backup is declared
      // complete. Third time this list has caught an addition of mine before a
      // reviewer did.
      'sync',
      // the three interchangeable hashers — see sha256_of
      'sha256sum',
      'shasum',
      'openssl',
      // functions defined by these two files
      'artefact_write',
      'ch_count_expression',
      'ch_query',
      'ch_row_counts',
      'cleanup',
      'copy_ch_artefact_to',
      'fail',
      'have_sha256',
      // The write helpers. Adding these two is exactly the audit gate doing its
      // job: they were introduced for the SIGPIPE fix and this test failed
      // until they were listed on purpose.
      'say',
      'note',
      'pg_can_count_rows',
      'pg_dump_to',
      'pg_query',
      'pg_row_counts',
      'remove_in_container_artefact',
      'remove_incomplete_output',
      'service_image',
      'service_running',
      'sha256_of',
      'start_app_if_stopped',
      'usage',
      'wait_until_healthy',
      'wait_until_stopped',
      'write_manifest',
    ])

    const observed = new Set<string>()
    const dockerCalls: string[] = []
    const runs: { env: NodeJS.ProcessEnv; mustFail: boolean }[] = [
      { env: {}, mustFail: false },
      { env: withShim({ SHIM_FAIL_BEFORE: 'FROM public.%I' }), mustFail: true },
    ]
    for (const { env, mustFail } of runs) {
      const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
      const trace = join(mkdtempSync(join(tmpdir(), 'lyraflow-trace-')), 'x')
      // `bash -x` on the shipped script: nothing about the script changes, it
      // is simply narrating itself.
      const res = spawnSync('bash', ['-c', `bash -x ./backup.sh "$1" 2>"$2"`, '_', dest, trace], {
        encoding: 'utf8',
        env: { ...SCRIPT_ENV, ...env },
      })
      expect(res.status === 0, `run mustFail=${mustFail}`).toBe(!mustFail)
      const written: string[] = []
      for (const line of readFileSync(trace, 'utf8').split('\n')) {
        const m = /^\++ (\S+)/.exec(line)
        if (!m) continue
        const word = m[1] as string
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue // an assignment
        observed.add(word.replace(/^'|'$/g, ''))
        if (word === 'docker') dockerCalls.push(line)
        const aw = /^\++ artefact_write (\S+)/.exec(line)
        if (aw) written.push(aw[1] as string)
      }

      // THE INVOCATION COUNT. Every file in the destination must correspond to
      // exactly one artefact_write call, and vice versa.
      //
      // This is what ends the spelling war, and it is why the `docker cp` ban
      // below is now belt-and-braces rather than the mechanism. The ban matched
      // only the unquoted form, so `docker compose "cp"` and `sub=cp; docker
      // compose "$sub"` walked straight through it. Counting invocations does
      // not care how the evasion is spelled: a file that appears without a
      // corresponding artefact_write call fails, whether it was made by `cp`,
      // `install`, `tee`, or `sort -o` — which is E3, previously documented as
      // open and now closed on every traced path.
      // Only on the run that succeeds: a failed run has its whole directory
      // removed, so there is nothing left to correspond to.
      if (!mustFail) {
        const produced = written
          .map((f) => f.replace(/\.tmp$/, '')) // MANIFEST.tmp is renamed into place
          .map((f) => f.slice(f.lastIndexOf('/') + 1))
          .sort()
        const stamps = readdirSync(dest)
        const onDisk =
          stamps.length === 1 ? readdirSync(join(dest, stamps[0] as string)).sort() : []
        expect(produced, 'artefact_write calls must match the files produced').toEqual(onDisk)
      }
    }

    const unexpected = [...observed].filter((c) => !ALLOWED.has(c)).sort()
    expect(
      unexpected,
      'a command outside the allow-list ran; if it is legitimate, add it here deliberately',
    ).toEqual([])
    expect(
      observed.size,
      'xtrace produced nothing — the audit would pass vacuously',
    ).toBeGreaterThan(20)

    // `docker` is necessarily allow-listed, so the allow-list above says nothing
    // about WHICH docker it ran — and `docker compose cp` writes to the host.
    // Auditing the sub-command set rather than banning one name closes the whole
    // family: the trace already carries full argv.
    const DOCKER_SUBCOMMANDS = new Set([
      'compose ps',
      'compose exec',
      'compose start',
      'compose stop',
      'inspect',
    ])
    const seenSub = new Set<string>()
    for (const line of dockerCalls) {
      const argv = line.replace(/^\++ /, '').split(/\s+/)
      const sub = argv[1] === 'compose' ? `compose ${argv[2]}` : (argv[1] as string)
      seenSub.add(sub)
    }
    expect(
      [...seenSub].filter((c) => !DOCKER_SUBCOMMANDS.has(c)).sort(),
      'an unaudited docker sub-command ran; `cp` writes to the host filesystem',
    ).toEqual([])
    expect(seenSub.size).toBeGreaterThan(2)
  }, 600_000)

  it('records checksums that match the artefacts it wrote', async () => {
    // A truncated artefact must be catchable by restore.sh while the live
    // data still exists. A manifest whose checksums are computed from
    // anything other than the bytes on disk cannot do that.
    const out = takeBackup()
    const m = parseManifest(join(out, 'MANIFEST'))
    expect(m.clickhouse_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.postgres_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256OfFile(join(out, 'clickhouse.zip'))).toBe(m.clickhouse_sha256)
    expect(sha256OfFile(join(out, 'postgres.dump'))).toBe(m.postgres_sha256)
  }, 300_000)

  it('leaves the app running, and healthy, before it returns', async () => {
    takeBackup()
    expect(await readyStatus()).toBe(200)
    // `/ready` alone does not pin this. `docker compose start` returns as soon
    // as the container is *running*, several seconds before the server answers,
    // and readyStatus() retries — so a script that returned early would still
    // satisfy the line above. The container's own healthcheck is the
    // deterministic signal: read the instant the script returns, it must
    // already say `healthy`, not `starting`. Anything an operator chains after
    // a backup — a smoke test, a monitoring probe, the next cron step — depends
    // on this being true rather than nearly true.
    const cid = compose('ps', '-aq', 'lyraflow').trim()
    const health = execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        cid,
      ],
      { encoding: 'utf8' },
    ).trim()
    expect(health).toBe('healthy')
  }, 300_000)

  it('restarts the app even when the ClickHouse step fails', async () => {
    // The whole cost of quiescing is this failure mode: a backup that dies
    // between `stop` and `start` leaves the site uninstrumented and nothing
    // announces it.
    //
    // The failure is forced with an archive name that is already on the
    // backups disk, which ClickHouse refuses with Code 598,
    // BACKUP_ALREADY_EXISTS. That is a real operator failure, not a synthetic
    // one: the disk lives inside the ClickHouse data volume and survives
    // `docker compose down`, so any run that dies between BACKUP and the
    // cleanup leaves its archive there, and a cron that overlaps or a wrapper
    // that retries immediately collides with it. Crucially it happens AFTER
    // the quiesce and no amount of destination validation can pre-empt it,
    // which is exactly the property this test needs.
    //
    // The archive is named from the same UTC second as the run, so the decoys
    // cover a window either side of the spawn.
    const now = Date.now()
    const decoys: string[] = []
    for (let i = 0; i < 20; i++) decoys.push(`lyraflow-${utcStamp(new Date(now + i * 1000))}.zip`)
    try {
      compose(
        'exec',
        '-T',
        'clickhouse',
        'sh',
        '-c',
        `cd ${CH_BACKUP_DIR} && touch ${decoys.join(' ')}`,
      )
      const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
      const err = runScriptExpectingFailure('./backup.sh', [dest])
      // Prove the failure is the one intended, not an unrelated one that would
      // make this test pass for the wrong reason.
      expect(err).toMatch(/BACKUP_ALREADY_EXISTS|598/)
      await waitReady(60_000)
      expect(await readyStatus()).toBe(200)

      // And it did not take the colliding archive with it. The name is derived
      // from a UTC *second*, so two backups launched milliseconds apart compute
      // the same one — the loser's cleanup must not delete the winner's
      // archive. Every decoy is still here; the run cleans up only what it
      // created.
      const surviving = backupsDirListing().trim().split('\n').sort()
      expect(surviving).toEqual([...decoys].sort())
    } finally {
      compose('exec', '-T', 'clickhouse', 'sh', '-c', `rm -f ${CH_BACKUP_DIR}/*.zip`)
    }
  }, 300_000)

  it('deletes the in-container artefact so the data volume does not grow', async () => {
    // The backups disk is inside the ClickHouse data volume (see
    // docker/clickhouse/backup-disk.xml), so the archive survives `docker
    // compose down` and accumulates one full backup per night.
    expect(backupsDirListing().trim()).toBe('')
    takeBackup()
    expect(backupsDirListing().trim()).toBe('')
  }, 300_000)

  it('restarts the app when `docker compose stop` stops it and then reports failure', async () => {
    // The failure mode the EXIT trap was never actually tested against. Every
    // other failure in this file reaches `exit 1` through fail(), by which
    // point the flag the trap reads is already set — so a flag set *after* the
    // stop looked correct everywhere.
    //
    // `docker compose stop` can stop the container and still exit non-zero:
    // Ctrl-C during the 30-second drain exits 130 with the container already
    // down, and the drain is the whole duration of the window. Under `set -e`
    // that kills the script at the `stop` line, before any assignment after it
    // — bypassing fail() entirely, so there is not even an error message.
    // Measured before the fix: `exited/unhealthy` immediately afterwards, and
    // still `exited/unhealthy` 50 seconds later.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const err = runScriptExpectingFailure(
      './backup.sh',
      [dest],
      withShim({ SHIM_FAIL_AFTER: 'compose stop lyraflow' }),
    )
    // It must announce itself rather than dying silently under `set -e`.
    expect(err).toMatch(/quiesce/i)
    expect(err).toMatch(/no data (was )?(changed|modified|lost)/i)

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
    expect(readdirSync(dest)).toHaveLength(0)
  }, 300_000)

  it('exits non-zero and does not claim success when the restart fails outright', async () => {
    // The mirror image of the flag-ordering bug, and worse than it. The flag
    // used to be cleared BEFORE `docker compose start` was attempted, so a
    // failed start was never retried by the trap; and a failed start was only a
    // warning, so the script printed "Backup written to …" and exited 0 with
    // the app down. A cron wrapper testing $? saw success.
    //
    // The shape every test asserting the app came back had in common: all of
    // them ran a backup in which `docker compose start` succeeded. The suite
    // already owned a shim that could fail exactly that command and had never
    // been pointed at it.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    let err: string
    try {
      err = runScriptExpectingFailure(
        './backup.sh',
        [dest],
        withShim({ SHIM_FAIL_BEFORE: 'compose start lyraflow' }),
      )
    } finally {
      // Whatever the assertions do, put the app back for the tests that follow.
      compose('start', 'lyraflow')
      await waitReady()
    }
    // It must say the app is down and point at the fix…
    expect(err).toMatch(/could not start it|still stopped|is stopped/i)
    expect(err).toMatch(/docker compose start lyraflow/)
    // …and the backup itself is complete, so it must not be thrown away or
    // hidden: the operator needs both facts.
    const stamps = readdirSync(dest)
    expect(stamps).toHaveLength(1)
    expect(readdirSync(join(dest, stamps[0] as string)).sort()).toEqual([
      'MANIFEST',
      'clickhouse.zip',
      'postgres.dump',
    ])
  }, 300_000)

  it('retries the restart, recovering a transient failure', async () => {
    // The Ctrl-C case, deterministically. bash defers SIGINT while a foreground
    // `docker compose` child runs, so the signal is delivered to a LATER
    // invocation — and when that is the restart, the restart dies with 130
    // while every other command in the run succeeded. A manual start seconds
    // later works, so a single retry from the EXIT trap recovers it, which is
    // what leaving APP_STOPPED set until the app is actually healthy buys.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const marker = join(shimDir, `marker-${Date.now()}`)
    const out = runScript(
      './backup.sh',
      [dest],
      withShim({ SHIM_FAIL_ONCE: 'compose start lyraflow', SHIM_MARKER: marker }),
    )
    // Exit 0 and a complete backup: the run recovered rather than merely
    // survived.
    expect(out).toMatch(/Backup written to/)
    expect(readdirSync(dest)).toHaveLength(1)
    // The first attempt really did fail — without this the test passes
    // vacuously if the shim never matched.
    expect(existsSync(marker), 'the shim never failed a restart').toBe(true)
    expect(await readyStatus()).toBe(200)
  }, 300_000)

  it('brings the app back even when a cleanup step itself fails', async () => {
    // Three review rounds found three different ways to leave the app stopped,
    // all in this path. The third: `remove_incomplete_output` ended in a bare
    // `rm -rf "$OUT"`, and on a destination that had gone read-only — which is
    // what ext4 does on an I/O error — `set -e` aborted the trap BEFORE the
    // restart. Constructed with a read-only bind mount: exit 1, container
    // `Exited (0)`, and "Starting the app again..." never printed.
    //
    // So this is deliberately not one test per cleanup step. The invariant is
    // that NO cleanup step can prevent the restart, and it is checked by
    // failing each of them in turn — the restart is now the first statement in
    // the trap and every step below it is individually incapable of returning
    // non-zero, so neither property is load-bearing alone.
    const cases = [
      {
        what: 'the in-container artefact removal (on a successful backup)',
        env: { SHIM_FAIL_BEFORE: `docker compose exec -T clickhouse rm -f ${CH_BACKUP_DIR}` },
        mustFail: false,
      },
      {
        what: 'the incomplete-output removal (on a failed backup)',
        env: { SHIM_FAIL_BEFORE: 'FROM public.%I', SHIM_FAIL_BEFORE2: 'rm -rf' },
        mustFail: true,
      },
    ]
    for (const { what, env, mustFail } of cases) {
      const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
      if (mustFail) {
        runScriptExpectingFailure('./backup.sh', [dest], withShim(env))
      } else {
        runScript('./backup.sh', [dest], withShim(env))
      }
      // The only thing that matters: the app is back.
      expect(await readyStatus(), `app must come back when ${what} fails`).toBe(200)
    }
    // Leave the backups disk clean for the volume-growth test's sake — the
    // first case above deliberately prevented the script from tidying it.
    compose('exec', '-T', 'clickhouse', 'sh', '-c', `rm -f ${CH_BACKUP_DIR}/*.zip`)
  }, 300_000)

  it('brings the app back when its own output is closed mid-run', async () => {
    // Every other test in this file invokes the script through execFileSync
    // with piped stdio and drains both streams to completion, so not one of
    // them ever closed the script's output. That gap hid a fourth way to leave
    // the app stopped, and the worst of the four: a plain `echo` to a closed
    // stdout dies of SIGPIPE, a shell killed by a signal does not run its EXIT
    // trap at all, and the pipeline's status is the READER's — so the app was
    // left down, stderr said nothing whatsoever, and `$?` was 0.
    //
    //   PIPESTATUS=141 head=0
    //   lyraflow-ci-lyraflow-1  exited  Exited (0)
    //
    // `| head -1` is the shape of `| less` then q, of `| grep -m1`, and of a
    // wrapper capping its log with `| head -n N`.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const res = spawnSync('bash', ['-c', './backup.sh "$1" | head -1', '_', dest], {
      encoding: 'utf8',
      env: SCRIPT_ENV,
    })

    // The one thing that matters.
    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)

    // And the backup itself completed. A wrapper capping its log asked for a
    // shorter log, not for an unfinished backup — so the correct outcome is a
    // whole backup, not a tidy absence of one.
    const stamps = readdirSync(dest)
    expect(stamps).toHaveLength(1)
    expect(readdirSync(join(dest, stamps[0] as string)).sort()).toEqual([
      'MANIFEST',
      'clickhouse.zip',
      'postgres.dump',
    ])

    // Swallowing the writes must not mean spraying bash's own write-error
    // diagnostics instead — five of them appeared on the first attempt at this.
    expect(res.stderr).not.toMatch(/write error|Broken pipe/)
  }, 300_000)

  it('completes the backup when BOTH streams are closed, not just stdout', async () => {
    // `trap "" PIPE` and say/note protect this shell's writes; they do nothing
    // for the `docker` children, which inherit fd 2 and die on their own. A log
    // -capping wrapper writes `2>&1 | ...`, so this is the same operator action
    // the stdout test covers — and before the `2>&1` on the stop it produced no
    // backup at all:
    //
    //   PIPESTATUS=1 0   container: healthy   dest: (empty)
    //   trace: rc=255  compose stop lyraflow
    //
    // Honest (non-zero, app healthy, nothing reported as written) but not what
    // the usage text promises about a capped log.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    spawnSync('bash', ['-c', './backup.sh "$1" 2>&1 | head -1', '_', dest], {
      encoding: 'utf8',
      env: SCRIPT_ENV,
    })
    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)

    const stamps = readdirSync(dest)
    expect(stamps, 'a capped log must not cost the backup').toHaveLength(1)
    expect(readdirSync(join(dest, stamps[0] as string)).sort()).toEqual([
      'MANIFEST',
      'clickhouse.zip',
      'postgres.dump',
    ])
  }, 300_000)

  it('keeps the app up if either cleanup guard alone is removed', async () => {
    // cleanup() has two independent reasons it cannot skip the restart: the
    // restart is its first statement, and every step below it is incapable of
    // failing. Mutating either alone leaves the suite green — which is correct,
    // and also how rounds 1→2→3 happened: with nothing pinning each guard
    // separately, one can be deleted silently and the next edit has nothing
    // left to fall back on. So each is pinned on its own.

    // GUARD 1 — the restart is first. With both streams merged, the restart
    // message must precede the removal warning; if the removals ran first the
    // order inverts. `rm -rf` is failed by the shim to make the warning appear
    // at all, and the manifest is failed so the removal runs.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const merged = spawnSync('bash', ['-c', './backup.sh "$1" 2>&1', '_', dest], {
      encoding: 'utf8',
      env: {
        ...SCRIPT_ENV,
        ...withShim({
          SHIM_FAIL_BEFORE: 'FROM public.%I',
          SHIM_FAIL_BEFORE2: 'rm -rf',
        }),
      },
    })
    const out = merged.stdout
    const restartAt = out.indexOf('Starting the app again')
    const warnAt = out.indexOf('could not remove the incomplete backup')
    expect(restartAt, 'no restart message').toBeGreaterThan(-1)
    expect(warnAt, 'no removal warning — the shim did not fire').toBeGreaterThan(-1)
    expect(restartAt, 'the restart must happen before the tidy-up').toBeLessThan(warnAt)

    // GUARD 2 — each cleanup step is incapable of returning non-zero. Called
    // directly, with its `rm` failed: the shipped version returns 0, the
    // bare-`rm -rf` version returns 1 and would abort the trap under `set -e`.
    const probe = spawnSync(
      'bash',
      [
        '-c',
        '. ./backup-lib.sh; OUT_CREATED=1; BACKUP_COMPLETE=0; OUT="$1"; ' +
          'remove_incomplete_output; echo "rc=$?"',
        '_',
        dest,
      ],
      { encoding: 'utf8', env: { ...SCRIPT_ENV, ...withShim({ SHIM_FAIL_BEFORE: 'rm -rf' }) } },
    )
    expect(probe.stdout).toContain('rc=0')
    expect(probe.stderr).toMatch(/could not remove the incomplete backup/)

    // GUARD 3 — inside start_app_if_stopped, the start precedes any write.
    // The SIGPIPE defect was exactly this ordering: the announcement was the
    // first statement, and on a closed stdout that one write killed the shell
    // before the app was started. With the PIPE trap and non-fatal say/note in
    // place the ordering is no longer independently observable at runtime — so
    // it is pinned here, in the same spirit as the umask position rule, rather
    // than left as the one layer nothing checks.
    const libCode = readFileSync('backup-lib.sh', 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const fnAt = libCode.indexOf('start_app_if_stopped() {')
    expect(fnAt).toBeGreaterThan(-1)
    const body = libCode.slice(fnAt, libCode.indexOf('\n}', fnAt))
    const startAt = body.indexOf('docker compose start')
    const firstWrite = body.search(/\b(say|note|echo|printf)\b/)
    expect(startAt, 'start_app_if_stopped must actually start the app').toBeGreaterThan(-1)
    expect(firstWrite, 'expected a progress message in start_app_if_stopped').toBeGreaterThan(-1)
    expect(startAt, 'the app must be started before anything is written').toBeLessThan(firstWrite)

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
  }, 300_000)

  it('leaves nothing behind when an artefact step fails part-way', async () => {
    // "A failed run leaves nothing" was true only for the manifest step. The
    // three artefacts appear one at a time, and a failure between them left a
    // directory that reads as a backup to anyone running `ls`:
    //
    //   pg_dump fails  -> postgres.dump 0 bytes + clickhouse.zip 8390 bytes
    //   copy-out fails -> clickhouse.zip 0 bytes
    //
    // restore.sh refuses a directory with no MANIFEST, so neither is as
    // dangerous as a short manifest — but the invariant is either true or it is
    // not, and this is the third of the script no test covered.
    for (const [what, match] of [
      ['the Postgres dump', 'pg_dump'],
      ['the ClickHouse copy-out', `cat ${CH_BACKUP_DIR}`],
    ] as const) {
      const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
      const err = runScriptExpectingFailure(
        './backup.sh',
        [dest],
        withShim({ SHIM_FAIL_BEFORE: match }),
      )
      expect(err, what).toMatch(/no data (was )?(changed|modified|lost)/i)
      expect(readdirSync(dest), `${what} must leave nothing behind`).toHaveLength(0)
      expect(await readyStatus()).toBe(200)
    }
  }, 300_000)

  it('leaves nothing behind when the manifest step fails', async () => {
    // A manifest written straight to its final name is a manifest that exists
    // before it is complete: the redirect creates the file, and `sort` writes
    // whatever it received before the left-hand side of the pipeline died.
    // Measured before the fix — a failure inside the Postgres row counts left
    // three files, correct checksums, `mode=quiesced` and a matching timestamp,
    // missing only the entire `rows.postgres.*` block. That satisfies every
    // other assertion in this file, and a restore.sh iterating those keys would
    // find none and report a flawless Postgres verification.
    //
    // The failure is injected at the row-count query specifically, so
    // schema_version and the ClickHouse counts both succeed first and the
    // manifest dies part-written rather than never starting.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const err = runScriptExpectingFailure(
      './backup.sh',
      [dest],
      // Matches only the row-count query, not the identically-shaped
      // validation probe that runs before the quiesce.
      withShim({ SHIM_FAIL_BEFORE: 'FROM public.%I' }),
    )
    expect(err).toMatch(/manifest/i)
    expect(err).toMatch(/no data (was )?(changed|modified|lost)/i)

    // Nothing at all: not a partial manifest, and not two artefacts sitting in
    // a directory that looks like a backup to anyone reading `ls`.
    expect(readdirSync(dest)).toHaveLength(0)
    expect(await readyStatus()).toBe(200)
  }, 300_000)

  it('refuses before the quiesce when Postgres cannot answer the row-count query', async () => {
    // The whole Postgres path — query_to_xml, and psql authenticating at all —
    // used to be exercised for the first time *after* the app was down, so a
    // Postgres built without libxml turned into downtime plus a failed backup
    // instead of a refusal. Same principle the script already applies to
    // finding a SHA-256 tool.
    const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
    const err = runScriptExpectingFailure(
      './backup.sh',
      [dest],
      // Matches only the validation probe, not the row-count query.
      withShim({ SHIM_FAIL_BEFORE: "query_to_xml('SELECT 1 AS c'" }),
    )
    expect(err).toMatch(/validation/i)
    expect(readdirSync(dest)).toHaveLength(0)
    // Refused before anything was stopped.
    expect(await readyStatus()).toBe(200)
  }, 300_000)

  it('names the failed step and the state of the data when it fails', async () => {
    // Whatever fails, an operator has to know two things immediately: which
    // step died, and whether their data is intact. A stack trace or a bare
    // ClickHouse error code answers neither, and this script runs unattended
    // at 4am where the log line is the only artefact of the failure.
    const err = runScriptExpectingFailure('./backup.sh', [unwritableDestination])
    expect(err).toMatch(/ClickHouse|Postgres|destination/i)
    expect(err).toMatch(/no data (was )?(changed|modified|lost)|nothing was changed/i)
  }, 300_000)

  it('refuses a destination it cannot write to, before stopping the app', async () => {
    // Validation belongs before the quiesce. Discovering the destination is
    // read-only after the app is down turns a typo into an outage.
    runScriptExpectingFailure('./backup.sh', [unwritableDestination])
    expect(await readyStatus()).toBe(200)
    // …and `/ready` answering is not on its own proof the app was never
    // stopped: this script restarts it on the way out, and waits for health
    // before returning. The container's start count is what separates "never
    // stopped" from "stopped and put back".
    const cid = compose('ps', '-aq', 'lyraflow').trim()
    const restarts = execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', cid], {
      encoding: 'utf8',
    }).trim()
    runScriptExpectingFailure('./backup.sh', [unwritableDestination])
    const after = execFileSync('docker', ['inspect', '--format', '{{.State.StartedAt}}', cid], {
      encoding: 'utf8',
    }).trim()
    expect(after).toBe(restarts)
  }, 300_000)

  it('refuses to run at all when the app service is not running', async () => {
    // The consistency claim rests entirely on the writer being stopped by THIS
    // script. If the app is already down for some other reason — a crash loop,
    // a half-finished upgrade — the operator is not backing up a quiesced
    // system, they are backing up an unknown one, and the manifest would still
    // say `mode=quiesced`.
    compose('stop', 'lyraflow')
    try {
      const dest = mkdtempSync(join(tmpdir(), 'lyraflow-backup-'))
      const err = runScriptExpectingFailure('./backup.sh', [dest])
      expect(err).toMatch(/lyraflow.*not running/i)
      // And it left nothing behind: a validation failure that has already
      // created a directory sends the operator looking for a backup that does
      // not exist.
      expect(readdirSync(dest)).toHaveLength(0)
    } finally {
      compose('start', 'lyraflow')
      await waitReady()
    }
  }, 300_000)
})

/**
 * Every count a restore is allowed to change, in one snapshot.
 *
 * `events` is read with FINAL because a merging engine's plain `count()`
 * moves on its own between two reads that are seconds apart — see
 * ch_count_expression in backup-lib.sh — which would make "nothing was
 * destroyed" flap for reasons that have nothing to do with restore.sh.
 */
async function liveState(): Promise<Record<string, string>> {
  return {
    events: await chScalar('SELECT count() FROM events FINAL'),
    deadLetter: await chScalar('SELECT count() FROM events_dead_letter'),
    deviceIndex: await chScalar('SELECT count() FROM device_index FINAL'),
    projects: pgScalar('SELECT count(*) FROM public.projects'),
    apiKeys: pgScalar('SELECT count(*) FROM public.api_keys'),
    suppressed: pgScalar('SELECT count(*) FROM public.suppressed_persons'),
  }
}

/**
 * Runs a restore that must be refused, and proves the refusal cost nothing.
 *
 * Three assertions, and all three are the point rather than belt-and-braces.
 * The rows prove no data was destroyed. The container's start time proves the
 * app was never even stopped — `/ready` cannot show that, because a script
 * that stopped the app and put it back looks identical from outside, and that
 * is exactly the difference between a guard that runs before the quiesce and
 * one that runs after it. The fingerprint proves the operator's only copy of
 * their data was not written to while it was being read.
 */
async function expectRefusal(out: string, input: string): Promise<string> {
  const before = await liveState()
  const startedAt = appStartedAt()
  const backupBefore = fingerprint(out)

  const err = runScriptExpectingFailure('./restore.sh', [out], {}, input)

  expect(await liveState(), 'a refusal must not destroy anything').toEqual(before)
  expect(appStartedAt(), 'a refusal must not even stop the app').toBe(startedAt)
  expect(fingerprint(out), 'a restore must not modify the backup').toEqual(backupBefore)
  return err
}

/** Ingests one event and returns once it has been flushed to ClickHouse. */
async function ingestOneEvent(anonymousId: string): Promise<void> {
  await fetch(`${BASE}/v1/track`, {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({
      message_id: randomUUID(),
      anonymous_id: anonymousId,
      event: 'after_the_backup',
      properties: { plan: 'pro' },
    }),
  })
  await new Promise((r) => setTimeout(r, 5000))
}

/**
 * Puts rows in `events_dead_letter`, which is the only table carrying a TTL
 * and therefore the only one whose row verification is allowed any latitude.
 *
 * Nothing the rest of this file does produces one: the fixtures all send valid
 * payloads. A payload that fails validation is answered 202 and recorded
 * verbatim in the dead-letter table — it is the only record that data arrived
 * and could not be stored — and that write is not buffered, so there is no
 * flush to wait for.
 */
async function seedDeadLetters(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await fetch(`${BASE}/v1/track`, {
      method: 'POST',
      headers: ingestHeaders(),
      // No `event`, which is required: validation_failed.
      body: JSON.stringify({ message_id: randomUUID(), anonymous_id: `dead-${i}` }),
    })
  }
  await new Promise((r) => setTimeout(r, 2000))
}

/** restore.sh with comment lines and here-document bodies removed. */
function restoreCode(): string {
  const out: string[] = []
  let terminator: string | null = null
  for (const line of readFileSync('restore.sh', 'utf8').split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    if (/^\s*#/.test(line)) continue
    const here = /<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(line)
    if (here) terminator = here[1] as string
    out.push(line)
  }
  expect(terminator, 'unterminated heredoc swallowed the rest of restore.sh').toBeNull()
  const stripped = out.join('\n')
  for (const landmark of ['usage()', 'cleanup()', 'trap cleanup EXIT', 'verify_row_counts()']) {
    expect(stripped, `${landmark} vanished from restore.sh — a heredoc ate it`).toContain(landmark)
  }
  return stripped
}

describe('restore.sh guards', () => {
  // GUARD 1, half a. A truncated archive must be caught while the live data
  // still exists — which is the entire reason backup.sh checksums the bytes
  // on disk rather than the copy inside the container.
  it('refuses a corrupted clickhouse.zip with the live data intact', async () => {
    const out = takeBackup()
    truncateFile(join(out, 'clickhouse.zip'), 128)
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/checksum/i)
    expect(err).toMatch(/clickhouse\.zip/)
  }, 300_000)

  // GUARD 1, half b, and it is a separate test on purpose. Checking only the
  // ClickHouse artefact passes the test above while leaving a truncated
  // Postgres dump — the half that carries the suppression list — completely
  // unchecked. Each half of a guard needs its own pin, or the half nothing
  // covers is the one the next edit deletes.
  it('refuses a corrupted postgres.dump with the live data intact', async () => {
    const out = takeBackup()
    truncateFile(join(out, 'postgres.dump'), 128)
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/checksum/i)
    expect(err).toMatch(/postgres\.dump/)
  }, 300_000)

  // GUARD 2. The same condition the app raises at boot as SchemaTooNewError,
  // but reached before the data is gone rather than after — the difference
  // between an error message and an outage.
  it('refuses a backup newer than the running image, before destroying anything', async () => {
    const out = takeBackup()
    rewriteManifestKey(join(out, 'MANIFEST'), 'schema_version', '9999')
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/newer than this build|schema_version|newer than the running image/i)
  }, 300_000)

  // GUARD 3. A non-empty answer that is not the timestamp: the mutation this
  // pins is "accept anything the operator typed", which `yes` walks straight
  // through.
  it('refuses when the typed confirmation does not match the timestamp', async () => {
    const out = takeBackup()
    const err = await expectRefusal(out, 'yes\n')
    expect(err).toMatch(/timestamp/i)
  }, 300_000)

  // …and fails CLOSED when there is nobody to answer. An empty stdin is what
  // cron, a CI job and an agent all present, and the failure mode a
  // confirmation must never have is "unattended callers are waved through".
  it('refuses a restore nobody confirmed', async () => {
    const out = takeBackup()
    const err = await expectRefusal(out, '')
    expect(err).toMatch(/timestamp/i)
  }, 300_000)

  // The manifest's own completeness, checked before anything is destroyed.
  //
  // backup.sh's write_manifest comment records what a short manifest looked
  // like when it could still happen: three files, correct checksums,
  // `mode=quiesced`, a matching timestamp, and the entire `rows.postgres.*`
  // block missing. It writes atomically now — so this is not a live defect —
  // but a restore that iterated an absent block would report a flawless
  // Postgres verification, which is the worst possible way to find out that
  // changed back.
  it('refuses a manifest that records no Postgres row counts', async () => {
    const out = takeBackup()
    dropManifestKeys(join(out, 'MANIFEST'), 'rows.postgres.')
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/no Postgres row counts/i)
  }, 300_000)

  it('refuses a manifest that records no ClickHouse row counts', async () => {
    const out = takeBackup()
    dropManifestKeys(join(out, 'MANIFEST'), 'rows.clickhouse.')
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/no ClickHouse row counts/i)
  }, 300_000)

  // A count with no expression cannot be compared: `count()` and `count()
  // FINAL` answer differently for four of the five ClickHouse tables and only
  // one of them is right. Caught here rather than at verification time, which
  // runs after the data is already gone.
  it('refuses a ClickHouse count the manifest gives no expression for', async () => {
    const out = takeBackup()
    dropManifestKeys(join(out, 'MANIFEST'), 'rowexpr.clickhouse.events=')
    const err = await expectRefusal(out, confirmation(out))
    expect(err).toMatch(/expression/i)
    expect(err).toMatch(/events/)
  }, 300_000)

  it('refuses a directory that is not a backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyraflow-notabackup-'))
    const before = await liveState()
    const startedAt = appStartedAt()
    const err = runScriptExpectingFailure('./restore.sh', [dir], {}, 'anything\n')
    expect(err).toMatch(/MANIFEST/)
    expect(await liveState()).toEqual(before)
    expect(appStartedAt()).toBe(startedAt)
  }, 300_000)

  it('refuses a backup that is missing an artefact', async () => {
    const out = takeBackup()
    execFileSync('rm', [join(out, 'postgres.dump')])
    const before = await liveState()
    const startedAt = appStartedAt()
    const err = runScriptExpectingFailure('./restore.sh', [out], {}, confirmation(out))
    expect(err).toMatch(/postgres\.dump/)
    expect(await liveState()).toEqual(before)
    expect(appStartedAt()).toBe(startedAt)
  }, 300_000)

  it('has no flag that restores only one store', () => {
    // The unsafe operation, and the one an operator under pressure reaches
    // for: a Postgres older than its ClickHouse partner has lost suppression
    // rows, and the people they hide become visible again.
    const src = readFileSync('restore.sh', 'utf8')
    expect(src).not.toMatch(/--postgres-only|--clickhouse-only|--only/)
  })

  it('restores ClickHouse before Postgres', () => {
    // A TRIPWIRE, NOT A PROOF. It is a source-text assertion: it fails loudly
    // on a reordering and says nothing about what the script does. The
    // behavioural pin is in the audit test below, which reads the order out of
    // an execution trace of a real restore, and Task 4's round trip is what
    // exercises the consequence.
    const src = readFileSync('restore.sh', 'utf8')
    expect(src.indexOf('RESTORE DATABASE')).toBeLessThan(src.indexOf('pg_restore'))
  })

  it('runs the three guards before anything is destroyed', () => {
    // The ordering rule the two tests above cannot see, pinned in the source
    // for the same reason backup.sh pins the umask's position: moving a guard
    // below the quiesce is a one-line edit, and each of the runtime tests
    // above only fails for the ONE guard it is aimed at. This says all three
    // are on the safe side of the line at once.
    const code = restoreCode()
    const destruction = code.indexOf('docker compose stop')
    expect(destruction, 'restore.sh must stop the app').toBeGreaterThan(-1)
    for (const guard of ['sha256_of "$SRC/clickhouse.zip"', 'image_schema_version', 'read -r']) {
      const at = code.indexOf(guard)
      expect(at, `${guard} not found in restore.sh`).toBeGreaterThan(-1)
      expect(at, `${guard} must run before the app is stopped`).toBeLessThan(destruction)
    }
    // …and the flag the EXIT trap reads is set BEFORE the stop, not after it.
    // Four review rounds on backup.sh were this one ordering: `docker compose
    // stop` can stop the container and still exit non-zero, and under `set -e`
    // an assignment placed after it never runs.
    const flag = code.indexOf('APP_STOPPED=1')
    expect(flag, 'restore.sh must record that it stopped the app').toBeGreaterThan(-1)
    expect(flag, 'APP_STOPPED=1 must precede the stop it describes').toBeLessThan(destruction)
  })
})

describe('restore.sh', () => {
  it('puts both stores back, and loses what was written after the backup', async () => {
    const out = takeBackup()
    const m = parseManifest(join(out, 'MANIFEST'))
    const backupBefore = fingerprint(out)

    // Diverge BOTH stores from the backup, so a restore that quietly did only
    // one of them cannot pass.
    const created = compose(
      'exec',
      '-T',
      'lyraflow',
      'node',
      'packages/cli/dist/index.js',
      'create-project',
      'AfterTheBackup',
    )
    expect(created).toMatch(/wk_[a-f0-9]+/)
    await ingestOneEvent('after-backup-anon')

    const diverged = await liveState()
    expect(diverged.projects).not.toBe(m['rows.postgres.projects'])
    expect(diverged.events).not.toBe(m['rows.clickhouse.events'])

    const stdout = runScript('./restore.sh', [out], {}, confirmation(out))
    expect(stdout).toMatch(/Restored from/)

    // Both stores are back at the backup's numbers, table by table, using the
    // expression the manifest itself names.
    for (const [key, value] of Object.entries(m)) {
      if (key.startsWith('rows.clickhouse.')) {
        const table = key.slice('rows.clickhouse.'.length)
        const expr = m[`rowexpr.clickhouse.${table}`] as string
        const final = expr.endsWith('FINAL') ? ' FINAL' : ''
        expect(await chScalar(`SELECT count() FROM \`${table}\`${final}`), table).toBe(value)
      }
      if (key.startsWith('rows.postgres.')) {
        const table = key.slice('rows.postgres.'.length)
        expect(pgScalar(`SELECT count(*) FROM public."${table}"`), table).toBe(value)
      }
    }

    // The app is back, healthy, and answering.
    expect(await readyStatus()).toBe(200)

    // The scratch archive this restore copied INTO the container is gone. The
    // backups disk lives inside the ClickHouse data volume, so an archive left
    // there survives `docker compose down` and grows the volume by one whole
    // backup per restore. CH_ARTEFACT_CREATED defaults to 0 in backup-lib.sh,
    // which makes forgetting to set it a silent no-op rather than an error.
    expect(backupsDirListing().trim()).toBe('')

    // And the backup itself is untouched — same bytes, same modes.
    expect(fingerprint(out)).toEqual(backupBefore)
  }, 600_000)

  it('restores a backup OLDER than the running image', async () => {
    // Pins `>` rather than `!=` or `<` in the schema guard. An older backup is
    // not an error, it is what disaster recovery IS: the app migrates it
    // forward on the next boot. A guard written with the comparison the wrong
    // way round refuses every real restore and passes the newer-backup test.
    const out = takeBackup()
    const image = Number(parseManifest(join(out, 'MANIFEST')).schema_version)
    expect(image).toBeGreaterThan(1)
    rewriteManifestKey(join(out, 'MANIFEST'), 'schema_version', '1')

    const stdout = runScript('./restore.sh', [out], {}, confirmation(out))
    expect(stdout).toMatch(/Restored from/)
    expect(await readyStatus()).toBe(200)
  }, 600_000)

  it('fails the restore when the restored rows disagree with the manifest', async () => {
    // The mutation this exists for is "log a warning and carry on". Nothing in
    // the guard tests can catch it: they all refuse before the restore runs,
    // and verification is the only check that happens after the data has
    // already been replaced — so it is the only one where a warning instead of
    // a non-zero exit is invisible.
    const out = takeBackup()
    const events = parseManifest(join(out, 'MANIFEST'))['rows.clickhouse.events'] as string
    rewriteManifestKey(join(out, 'MANIFEST'), 'rows.clickhouse.events', String(Number(events) + 7))

    const err = runScriptExpectingFailure('./restore.sh', [out], {}, confirmation(out))
    expect(err).toMatch(/verification/i)
    expect(err).toMatch(/clickhouse\.events/)
    expect(err).toContain(String(Number(events) + 7))

    // A failed verification still has to leave the app running: the data has
    // been replaced either way, and a site that is dark on top of it is worse.
    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
    expect(backupsDirListing().trim()).toBe('')
  }, 600_000)

  it('treats a lower count as expected only where the manifest records a TTL', async () => {
    // `events_dead_letter` carries a table-level TTL, so its rows are deleted
    // by the same background merges that collapse the others — restoring a
    // backup older than the retention window is ordinary disaster recovery and
    // must not read as catastrophic loss. Every other table gets no such
    // latitude, and no table gets it in the other direction: nothing about a
    // TTL can invent rows.
    await seedDeadLetters(3)
    const out = takeBackup()
    const m = parseManifest(join(out, 'MANIFEST'))
    expect(m['rowttl.clickhouse.events_dead_letter']).toBeTruthy()
    expect(m['rowttl.clickhouse.events']).toBeUndefined()
    const dead = Number(m['rows.clickhouse.events_dead_letter'])
    expect(dead).toBeGreaterThan(0)

    // Manifest HIGHER than the restored count, on the table with a TTL: fine.
    rewriteManifestKey(
      join(out, 'MANIFEST'),
      'rows.clickhouse.events_dead_letter',
      String(dead + 5),
    )
    const stdout = runScript('./restore.sh', [out], {}, confirmation(out))
    expect(stdout).toMatch(/Restored from/)
    expect(stdout).toMatch(/lower is expected/i)

    // Manifest LOWER than the restored count, same table: still a failure. A
    // TTL only ever removes rows.
    rewriteManifestKey(
      join(out, 'MANIFEST'),
      'rows.clickhouse.events_dead_letter',
      String(dead - 1),
    )
    const err = runScriptExpectingFailure('./restore.sh', [out], {}, confirmation(out))
    expect(err).toMatch(/verification/i)
    expect(err).toMatch(/events_dead_letter/)
    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
  }, 900_000)

  it('counts ClickHouse rows with the expression the manifest names', async () => {
    // The contract that has no natural fixture: `count()` and `count() FINAL`
    // agree on a table whose parts have merged, and every table's parts have
    // merged within seconds. Measured on this branch — device_index went from
    // count()=5 to count()=3 within five seconds of a RESTORE while FINAL was
    // 3 at every sample — so a test that just restores and looks would pass
    // against a bare `count()` most of the time and fail some of the time,
    // which is worse than not having one.
    //
    // So the window is held open instead of raced: the table's own merge
    // settings are frozen, and because they are table settings they are
    // carried in the archive and come back with the RESTORE. Measured: count()
    // stayed 5 against FINAL 3 for the whole 25s after a restore.
    const freeze =
      'ALTER TABLE device_index MODIFY SETTING' +
      ' max_bytes_to_merge_at_max_space_in_pool = 1, max_bytes_to_merge_at_min_space_in_pool = 1'
    const thaw =
      'ALTER TABLE device_index RESET SETTING' +
      ' max_bytes_to_merge_at_max_space_in_pool, max_bytes_to_merge_at_min_space_in_pool'
    await chScalar(freeze)
    try {
      // One anonymous_id, four flush batches: four device_index rows sharing a
      // sorting key, in four parts that will now never merge.
      for (let i = 0; i < 4; i++) {
        await fetch(`${BASE}/v1/identify`, {
          method: 'POST',
          headers: ingestHeaders(),
          body: JSON.stringify({
            message_id: randomUUID(),
            anonymous_id: 'frozen-anon',
            user_id: 'frozen-person',
            traits: { n: i },
          }),
        })
        await new Promise((r) => setTimeout(r, 4000))
      }
      await new Promise((r) => setTimeout(r, 5000))

      const raw = await chScalar('SELECT count() FROM device_index')
      const merged = await chScalar('SELECT count() FROM device_index FINAL')
      expect(
        Number(raw),
        'the fixture did not diverge — this test would pass vacuously',
      ).toBeGreaterThan(Number(merged))

      const out = takeBackup()
      const m = parseManifest(join(out, 'MANIFEST'))
      expect(m['rowexpr.clickhouse.device_index']).toBe('count() FINAL')
      expect(m['rows.clickhouse.device_index']).toBe(merged)

      const stdout = runScript('./restore.sh', [out], {}, confirmation(out))
      expect(stdout).toMatch(/Restored from/)

      // The divergence survived the restore, so a bare `count()` really did
      // have a wrong answer available to it throughout.
      expect(Number(await chScalar('SELECT count() FROM device_index'))).toBeGreaterThan(
        Number(await chScalar('SELECT count() FROM device_index FINAL')),
      )
    } finally {
      await chScalar(thaw)
    }
  }, 900_000)

  it('restarts the app and names the state when the Postgres step fails', async () => {
    // The half-restored state, and the only one an operator can be left in:
    // ClickHouse replaced, Postgres still current. It is the SAFE half — a
    // deleted person's events are back but their suppression row is still
    // there, so they stay hidden — and the message has to say so, because the
    // obvious reading of "the restore failed" is that nothing happened.
    const out = takeBackup()
    const err = runScriptExpectingFailure(
      './restore.sh',
      [out],
      withShim({ SHIM_FAIL_BEFORE: 'DROP SCHEMA IF EXISTS public' }),
      confirmation(out),
    )
    expect(err).toMatch(/Postgres/)
    expect(err).toMatch(/STATE OF YOUR DATA/)
    // It must name which half happened, not just that something failed.
    expect(err).toMatch(/ClickHouse has been restored/i)
    expect(err).toMatch(/Postgres has NOT been touched/i)

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
    // The scratch archive is cleaned up from the failure path too.
    expect(backupsDirListing().trim()).toBe('')

    // Leave the stack consistent for whatever runs next.
    runScript('./restore.sh', [out], {}, confirmation(out))
  }, 900_000)

  it('reads a manifest value that contains an `=`', async () => {
    // write_manifest's contract, in backup-lib.sh: a parser must split on the
    // FIRST `=` and take the whole remainder. Keys never contain one, values
    // can — a `rowttl` value is an arbitrary ClickHouse expression, and a
    // `TTL … GROUP BY … SET x = max(y)` contains spaces, parentheses AND an
    // `=`. A parser that splits on every `=`, or takes the last one, truncates
    // it silently.
    //
    // No value Lyraflow writes today contains one, so nothing else in this
    // suite could tell the two parsers apart — which is exactly how a rule
    // with no test survives until the migration that adds such a TTL. The
    // `timestamp` is used verbatim, for the confirmation and for the
    // in-container archive name, so bending it is the one way to make the rule
    // observable: a last-`=` parser would ask the operator to type `y`.
    const out = takeBackup()
    const bent = `${manifestTimestamp(out)}=x=y`
    rewriteManifestKey(join(out, 'MANIFEST'), 'timestamp', bent)

    const stdout = runScript('./restore.sh', [out], {}, `${bent}\n`)
    expect(stdout).toContain(bent)
    expect(await readyStatus()).toBe(200)
    expect(backupsDirListing().trim()).toBe('')
  }, 900_000)

  it('restarts the app when `docker compose stop` stops it and then reports failure', async () => {
    // The Critical backup.sh spent four review rounds on, and the reason
    // APP_STOPPED is set BEFORE the stop rather than after it. `docker compose
    // stop` can stop the container and still exit non-zero — Ctrl-C during the
    // 30-second drain exits 130 with the container already down — and under
    // `set -e` that kills the script at the `stop` line, before any assignment
    // placed after it could run. The EXIT trap then reads a flag that was
    // never set and leaves the app stopped with nothing announcing it.
    //
    // The source-position rule in the guards block above pins the ordering in
    // the file. This pins the consequence, which is what actually matters, and
    // it is the one assertion that would have caught the original defect.
    const out = takeBackup()
    const err = runScriptExpectingFailure(
      './restore.sh',
      [out],
      withShim({ SHIM_FAIL_AFTER: 'compose stop lyraflow' }),
      confirmation(out),
    )
    // It must announce itself rather than dying silently under `set -e`…
    expect(err).toMatch(/quiesce/i)
    // …and say the data is untouched, because at that point it is: the stop
    // is the last step before anything is destroyed.
    expect(err).toMatch(/nothing has been changed/i)

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
  }, 900_000)

  it('replaces the Postgres schema rather than layering the dump over it', async () => {
    // MEASURED, and the reason the schema is dropped and recreated instead of
    // relying on `--clean --if-exists` alone: `--clean` only drops what is IN
    // the dump. Restoring onto a live schema exits 0 with no output and leaves
    // every object the dump does not mention still standing.
    //
    // That is not a hypothetical shape. Restore a backup from schema version 9
    // into a version-11 database and the tables migrations 10 and 11 created
    // survive, holding rows from an era the restored `schema_migrations` says
    // never happened — and the next boot re-runs those two migrations against
    // tables that already exist.
    //
    // `left_over_table` stands in for exactly that. Nothing else in this file
    // would notice it: every other assertion iterates the manifest, and a
    // table the manifest has never heard of is invisible to all of them.
    const out = takeBackup()
    pgScalar('CREATE TABLE public.left_over_table (id int)')
    expect(
      pgScalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'left_over_table'",
      ),
    ).toBe('1')

    runScript('./restore.sh', [out], {}, confirmation(out))

    expect(
      pgScalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'left_over_table'",
      ),
      'a restore must replace the schema, not overlay the dump on it',
    ).toBe('0')
    expect(await readyStatus()).toBe(200)
  }, 900_000)

  it('says what happened to the data when a signal kills it mid-restore', async () => {
    // THE ONE EXIT NOTHING IN THIS FILE USED TO TAKE. Every other route out of
    // the destructive region goes through `abort`, which prints the data
    // state; a signal goes through neither `abort` nor any of the failure
    // branches, and before this test the whole run said:
    //
    //   Stopping the app... / Restoring ClickHouse... / Restoring Postgres...
    //   Starting the app again...
    //   exit 143
    //
    // …while leaving a ClickHouse full of restored events beside an EMPTY
    // Postgres. The app then restarted onto the empty schema, re-migrated
    // forward, and came up healthy with zero suppression rows — the state this
    // script's own header calls "a privacy regression, and a silent one",
    // reached without a word about it.
    //
    // SIGTERM is ordinary here: `timeout`, systemd stopping a unit, a
    // supervisor, a CI cancel, a plain `kill`. The shim parks one exactly
    // between the Postgres drop and the Postgres refill.
    const out = takeBackup()
    const res = spawnSync('./restore.sh', [out], {
      encoding: 'utf8',
      env: { ...SCRIPT_ENV, ...withShim({ SHIM_KILL_BEFORE: 'pg_restore' }) },
      input: confirmation(out),
    })
    expect(res.status === 0, 'a killed restore must not report success').toBe(false)

    // The whole point: it says so, and it says which of the states it is.
    expect(res.stderr).toMatch(/STATE OF YOUR DATA/)
    expect(res.stderr).toMatch(/Postgres is EMPTY/i)
    expect(res.stderr).toMatch(/run this script again/i)

    // …and the EXIT trap still did its job.
    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
    expect(backupsDirListing().trim()).toBe('')

    // Put the stack back for whatever runs next.
    runScript('./restore.sh', [out], {}, confirmation(out))
    expect(Number(pgScalar('SELECT count(*) FROM public.suppressed_persons'))).toBeGreaterThan(0)
  }, 900_000)

  it('does not add a stderr line to a restore that worked', async () => {
    // The other half of the fix above. Announcing the data state on every exit
    // that changed something must not mean announcing it on the exit where
    // stdout has already said the same thing positively — a cron wrapper that
    // treats any stderr output as a problem should not be handed one by a
    // restore that succeeded.
    const out = takeBackup()
    const res = spawnSync('./restore.sh', [out], {
      encoding: 'utf8',
      env: SCRIPT_ENV,
      input: confirmation(out),
    })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/Both stores now match/)
    expect(res.stderr).not.toMatch(/STATE OF YOUR DATA/)
  }, 900_000)

  it('fails the restore when a POSTGRES count disagrees with the manifest', async () => {
    // Verification has two halves and only the ClickHouse one was pinned:
    // every test that made verification fail rewrote a ClickHouse count, so
    // deleting the entire Postgres loop left the suite green. That half covers
    // `suppressed_persons` — the table the whole ClickHouse-before-Postgres
    // argument exists to protect — and it is the only check of it that runs
    // after the data has already been replaced.
    const out = takeBackup()
    const before = parseManifest(join(out, 'MANIFEST'))[
      'rows.postgres.suppressed_persons'
    ] as string
    expect(Number(before), 'the fixture never suppressed anyone').toBeGreaterThan(0)
    rewriteManifestKey(
      join(out, 'MANIFEST'),
      'rows.postgres.suppressed_persons',
      String(Number(before) + 3),
    )

    const err = runScriptExpectingFailure('./restore.sh', [out], {}, confirmation(out))
    expect(err).toMatch(/verification/i)
    expect(err).toMatch(/postgres\.suppressed_persons/)
    expect(err).toContain(String(Number(before) + 3))

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
  }, 900_000)

  it('exits non-zero and does not claim success when the restart fails outright', async () => {
    // `backup.sh`'s round-3 Critical, reproduced in `restore.sh` and until now
    // undefended: `restore.sh` has its own 14-line `cleanup()`, and every test
    // pinning that `exit 1` lived under `describe('backup.sh')`. Deleting the
    // line here left the suite green while the script printed "Both stores now
    // match the backup…" and exited 0 with the container `Exited (0)`.
    const out = takeBackup()
    let err: string
    try {
      err = runScriptExpectingFailure(
        './restore.sh',
        [out],
        withShim({ SHIM_FAIL_BEFORE: 'compose start lyraflow' }),
        confirmation(out),
      )
    } finally {
      // Whatever the assertions do, put the app back for the tests that follow.
      compose('start', 'lyraflow')
      await waitReady()
    }
    expect(err).toMatch(/could not start it|is stopped/i)
    expect(err).toMatch(/docker compose start lyraflow/)
    // The data state has to travel with it: "the app is down" is not
    // actionable without "and here is what state your data is in".
    expect(err).toMatch(/STATE OF YOUR DATA/)
  }, 900_000)

  it('removes the archive it copied in even when that copy then fails', async () => {
    // `CH_ARTEFACT_CREATED=1` goes BEFORE the copy, not after it. The archive
    // name comes from the manifest's timestamp rather than the clock, so a
    // retry recomputes the same name on purpose and overwrites its own
    // leftovers — there is no concurrent run whose archive this could be, which
    // is the race that makes `backup.sh` set the same flag late.
    //
    // Set late here, a copy that runs and then reports failure leaks a whole
    // database archive onto a disk that lives inside the ClickHouse data
    // volume and survives `docker compose down`. One per abandoned run, for
    // ever. The success path was already pinned; this is the other one.
    const out = takeBackup()
    expect(backupsDirListing().trim()).toBe('')

    const err = runScriptExpectingFailure(
      './restore.sh',
      [out],
      withShim({ SHIM_FAIL_AFTER: 'sh -c cat >' }),
      confirmation(out),
    )
    expect(err).toMatch(/ClickHouse/)
    // Nothing was destroyed — the copy is the last step before the DROP.
    expect(err).toMatch(/nothing has been changed/i)

    await waitReady(120_000)
    expect(await readyStatus()).toBe(200)
    expect(
      backupsDirListing().trim(),
      'a copy that failed part way must not leave its archive behind',
    ).toBe('')
  }, 900_000)

  it('verifies the restored rows before the app can accept new ones', async () => {
    // The reason verification runs while the app is still stopped, pinned
    // rather than argued. Under continuous ingest, verification moved back
    // below the restart reports a completely successful restore as data loss —
    // the SDK's queued events start arriving the moment the app answers, and
    // they land before the check reads the counts.
    //
    // The shipped order cannot see them at all, so this is deterministic in
    // both directions: the load runs throughout, and the restore must still
    // exit 0.
    //
    // `runScriptAsync`, NOT `runScript`. The first version of this test used
    // the synchronous helper and passed against the defect: `execFileSync`
    // blocks the whole event loop, so the load loop beside it never issued one
    // request, and "the restore succeeded under load" was really "the restore
    // succeeded under no load at all". `accepted` below is the guard against
    // that ever being true again quietly.
    const out = takeBackup()
    const expectedEvents = parseManifest(join(out, 'MANIFEST'))['rows.clickhouse.events'] as string
    let loading = true
    let accepted = 0
    const load = (async () => {
      while (loading) {
        try {
          const res = await fetch(`${BASE}/v1/track`, {
            method: 'POST',
            headers: ingestHeaders(),
            body: JSON.stringify({
              message_id: randomUUID(),
              anonymous_id: 'under-load',
              event: 'during_restore',
            }),
          })
          if (res.status === 202) accepted++
        } catch {
          // The app is stopped for most of this; a refused connection is the
          // expected answer and not what the test is about.
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    })()

    try {
      const res = await runScriptAsync('./restore.sh', [out], confirmation(out))
      expect(res.status, res.stderr).toBe(0)
      expect(res.stdout).toMatch(/Restored from/)
    } finally {
      // Keep the load on for a moment past the restore, so the events accepted
      // while the script was finishing are flushed rather than left in the
      // buffer — a verification that ran after the restart would have been
      // reading exactly this window.
      await new Promise((r) => setTimeout(r, 6000))
      loading = false
      await load
    }

    // The load was real: the app accepted events during this test, and they
    // reached ClickHouse. Without this the test passes vacuously whenever the
    // load fails to run — which is precisely how its first version passed.
    expect(accepted, 'no event was accepted; this test proved nothing').toBeGreaterThan(5)
    expect(
      Number(await chScalar('SELECT count() FROM events FINAL')),
      'the accepted events never reached ClickHouse',
    ).toBeGreaterThan(Number(expectedEvents))
    expect(await readyStatus()).toBe(200)
  }, 900_000)

  it('completes the restore when its own output is closed mid-run', async () => {
    // `restore.sh` inherits backup.sh's `trap "" PIPE` and its non-fatal
    // say/note, and had no test for either. It also has the two commands in
    // this pair of scripts that carry no redirect at all — the copy into the
    // container and the Postgres restore — so their stderr goes straight to
    // whatever the caller left open.
    //
    // Both shapes of a log-capping wrapper: stdout closed, and both streams
    // closed. `| head -1` is also `| less` then q, and `| grep -m1`.
    //
    // THE DIVERGENCE IS THE ASSERTION. The first version of this test checked
    // only that the app was healthy and the backups disk clean afterwards —
    // both of which are also true of a restore that died on its very first
    // `say`, before touching anything, which is exactly what happens with the
    // PIPE trap removed. Constructed: `trap "" PIPE` deleted and the test still
    // passed. A project created after the backup and gone afterwards is the
    // only evidence that the run reached the end rather than the beginning.
    for (const pipeline of ['./restore.sh "$1" | head -1', './restore.sh "$1" 2>&1 | head -1']) {
      const out = takeBackup()
      const expectedProjects = parseManifest(join(out, 'MANIFEST'))[
        'rows.postgres.projects'
      ] as string
      compose(
        'exec',
        '-T',
        'lyraflow',
        'node',
        'packages/cli/dist/index.js',
        'create-project',
        `ClosedStream${Date.now()}`,
      )
      expect(pgScalar('SELECT count(*) FROM public.projects'), pipeline).not.toBe(expectedProjects)

      const res = spawnSync('bash', ['-c', pipeline, '_', out], {
        encoding: 'utf8',
        env: SCRIPT_ENV,
        input: confirmation(out),
      })
      await waitReady(120_000)
      expect(await readyStatus(), pipeline).toBe(200)
      // A capped log asked for a shorter log, not for an abandoned restore.
      expect(
        pgScalar('SELECT count(*) FROM public.projects'),
        `${pipeline} — the restore did not run to completion`,
      ).toBe(expectedProjects)
      expect(backupsDirListing().trim(), pipeline).toBe('')
      expect(
        Number(pgScalar('SELECT count(*) FROM public.suppressed_persons')),
        pipeline,
      ).toBeGreaterThan(0)
      expect(res.stderr, pipeline).not.toMatch(/write error|Broken pipe/)
    }
  }, 900_000)

  it('runs no command that could create a file, and restores in the right order', async () => {
    // The runtime half of two separate claims, both from a single trace of a
    // real restore.
    //
    // ONE: restore.sh creates nothing on the host. backup.sh funnels every
    // file it writes through one `artefact_write`; this script writes no host
    // file at all, so the corresponding assertion is that it calls that
    // function zero times and that the backup directory is byte-identical
    // afterwards. The one file it does create lives INSIDE the ClickHouse
    // container, and `docker compose cp` is specifically not how it gets there
    // — `cp` reproduces the host file's 0600 and the server, running as
    // `clickhouse`, then cannot read the archive it is being asked to restore.
    //
    // TWO: the order. The source tripwire above proves the two statements
    // appear in the right order in the file; this proves the two commands RAN
    // in that order, which is what the privacy argument actually rests on.
    const ALLOWED = new Set([
      // shell builtins and keywords bash reports
      '[',
      '.',
      'case',
      'cd',
      'command',
      'continue',
      'echo',
      'exit',
      'for',
      'local',
      'printf',
      'pwd',
      'read',
      'return',
      'set',
      'shift',
      'sleep',
      'trap',
      // external programs
      'awk',
      'cat',
      'dirname',
      'docker',
      'grep',
      'head',
      'rm',
      'sha256sum',
      'shasum',
      'openssl',
      // functions defined by restore.sh and backup-lib.sh
      'abort',
      'ch_query',
      'cleanup',
      'have_sha256',
      'image_schema_version',
      'manifest_get',
      'manifest_keys',
      'note',
      'pg_query',
      'refuse',
      'remove_in_container_artefact',
      'safe_identifier',
      'say',
      'service_image',
      'service_running',
      'sha256_of',
      'start_app_if_stopped',
      'usage',
      'verify_row_counts',
      'wait_until_healthy',
      'wait_until_stopped',
    ])

    const out = takeBackup()
    const backupBefore = fingerprint(out)
    const trace = join(mkdtempSync(join(tmpdir(), 'lyraflow-trace-')), 'x')
    const res = spawnSync('bash', ['-c', `bash -x ./restore.sh "$1" 2>"$2"`, '_', out, trace], {
      encoding: 'utf8',
      env: SCRIPT_ENV,
      input: confirmation(out),
    })
    expect(res.status, `restore failed: ${readFileSync(trace, 'utf8').slice(-2000)}`).toBe(0)

    const observed = new Set<string>()
    const dockerCalls: string[] = []
    let artefactWrites = 0
    let chRestoreAt = -1
    let pgRestoreAt = -1
    const lines = readFileSync(trace, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = /^\++ (\S+)/.exec(line)
      if (!m) return
      const word = m[1] as string
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return // an assignment
      observed.add(word.replace(/^'|'$/g, ''))
      if (word === 'docker') dockerCalls.push(line)
      if (word === 'artefact_write') artefactWrites++
      if (chRestoreAt === -1 && line.includes('RESTORE DATABASE lyraflow')) chRestoreAt = i
      if (pgRestoreAt === -1 && line.includes('pg_restore')) pgRestoreAt = i
    })

    expect(
      observed.size,
      'xtrace produced nothing — the audit would pass vacuously',
    ).toBeGreaterThan(20)
    expect(
      [...observed].filter((c) => !ALLOWED.has(c)).sort(),
      'a command outside the allow-list ran; if it is legitimate, add it here deliberately',
    ).toEqual([])

    // ONE.
    expect(artefactWrites, 'restore.sh must write no host file').toBe(0)
    expect(fingerprint(out), 'a restore must not modify the backup').toEqual(backupBefore)

    const DOCKER_SUBCOMMANDS = new Set([
      'compose ps',
      'compose exec',
      'compose start',
      'compose stop',
      'inspect',
    ])
    const seenSub = new Set<string>()
    for (const line of dockerCalls) {
      const argv = line.replace(/^\++ /, '').split(/\s+/)
      seenSub.add(argv[1] === 'compose' ? `compose ${argv[2]}` : (argv[1] as string))
    }
    expect(
      [...seenSub].filter((c) => !DOCKER_SUBCOMMANDS.has(c)).sort(),
      'an unaudited docker sub-command ran; `cp` would land the archive unreadable',
    ).toEqual([])
    expect(seenSub.size).toBeGreaterThan(2)

    // TWO.
    expect(chRestoreAt, 'no ClickHouse RESTORE in the trace').toBeGreaterThan(-1)
    expect(pgRestoreAt, 'no pg_restore in the trace').toBeGreaterThan(-1)
    expect(chRestoreAt, 'ClickHouse must be restored before Postgres').toBeLessThan(pgRestoreAt)

    expect(await readyStatus()).toBe(200)
  }, 900_000)
})
