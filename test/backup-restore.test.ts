import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
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
      return out.join('\n')
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
      for (const line of readFileSync(trace, 'utf8').split('\n')) {
        const m = /^\++ (\S+)/.exec(line)
        if (!m) continue
        const word = m[1] as string
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue // an assignment
        observed.add(word.replace(/^'|'$/g, ''))
        if (word === 'docker') dockerCalls.push(line)
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
