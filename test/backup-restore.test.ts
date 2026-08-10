import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(script, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...SCRIPT_ENV, ...env },
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
): string {
  try {
    runScript(script, args, env)
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

/** A single scalar from ClickHouse over HTTP — no build artefacts required. */
async function chScalar(sql: string): Promise<string> {
  const res = await fetch('http://localhost:8123/?database=lyraflow', {
    method: 'POST',
    headers: { 'x-clickhouse-user': 'lyraflow', 'x-clickhouse-key': 'lyraflow' },
    body: sql,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}`)
  return text.trim()
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
  const shim = join(shimDir, 'docker')
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'if [ -n "${SHIM_FAIL_BEFORE:-}" ]; then',
      '  case "$*" in *"$SHIM_FAIL_BEFORE"*) exit 1 ;; esac',
      'fi',
      'if [ -n "${SHIM_FAIL_AFTER:-}" ]; then',
      `  case "$*" in *"$SHIM_FAIL_AFTER"*) ${realDocker} "$@"; exit 1 ;; esac`,
      'fi',
      `exec ${realDocker} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
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

    const chTables = Object.keys(m)
      .filter((k) => k.startsWith('rows.clickhouse.'))
      .map((k) => k.slice('rows.clickhouse.'.length))
    expect(chTables.sort()).toEqual([
      'device_index',
      'event_schema',
      'events',
      'events_dead_letter',
      'person_traits',
    ])
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
    const code = (f: string): string =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')

    const script = readFileSync('backup.sh', 'utf8')
    expect(script).toMatch(/^umask 077$/m)
    for (const f of ['backup.sh', 'backup-lib.sh']) {
      expect(code(f), `${f} must not chmod its way to the right modes`).not.toMatch(/\bchmod\b/)
    }
    // …and the umask must precede everything that can create a file, which
    // starts with sourcing the library.
    expect(script.indexOf('umask 077')).toBeLessThan(script.indexOf('backup-lib.sh'))
  })

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
