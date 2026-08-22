import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { buildApp } from './app.js'
import { ensureAdminUser } from './auth/bootstrap.js'
import { loadConfig } from './config.js'
import { Readiness } from './health.js'
import { ensureIdentityDictionaries, parsePgUrl } from './identity/dictionaries.js'
import { flushLogger } from './log-flush.js'
import { installShutdownHandlers } from './shutdown.js'

// Bounds every logger flush this file performs before a process.exit().
// Long enough for pino's default async stdout destination to land a normal
// line under Docker; short enough that a stalled destination delays exit by
// at most this much rather than hanging the container.
const LOG_FLUSH_TIMEOUT_MS = 1000

const config = loadConfig(process.env)
const pg = createPgPool(config.pgUrl)
const ch = createChClient(config.ch)
const readiness = new Readiness()

const app = buildApp({ config, pg, ch, readiness })

installShutdownHandlers({
  app,
  readiness,
  buffer: app.deps.buffer,
  counters: app.deps.counters,
  purge: app.deps.purge,
  retention: app.deps.retention,
  sessionSweeper: app.deps.sessionSweeper,
  projectPurge: app.deps.projectPurge,
  drainDeadlineMs: config.drainDeadlineMs,
})

// Migrations run on boot so that `docker compose pull && up -d` is the entire
// upgrade procedure. The advisory lock makes concurrent starts safe. This is
// the one failure an operator is actually likely to hit during an upgrade
// (a bad migration, a locked-out DB), so it goes through the already-
// constructed pino logger as a fatal, structured log line rather than
// surfacing as a raw unhandled top-level-await rejection dumped to stderr.
// The flush before exit matters: pino's default stdout destination writes
// asynchronously when stdout is a pipe (the normal case under Docker), and
// process.exit() can otherwise terminate the process before this one line
// — the entire reason this try/catch exists — actually reaches the log.
const migrationsDir = join(import.meta.dirname, '..', '..', 'db', 'migrations')
try {
  const { applied } = await migrate({
    pg,
    ch,
    migrations: loadMigrations(migrationsDir),
    appSchemaVersion: SCHEMA_VERSION,
  })
  app.log.info({ applied }, 'migrations complete')
} catch (err) {
  app.log.fatal({ err }, 'migrations failed')
  await flushLogger(app.log, LOG_FLUSH_TIMEOUT_MS)
  process.exit(1)
}

// Identity dictionaries are created here rather than as a migration: the DDL
// embeds the Postgres password, and migrations are committed .sql files in a
// public repository. Creating them at boot from credentials already in the
// process environment keeps the secret out of git, and `CREATE OR REPLACE
// DICTIONARY` also picks up a rotated password, which a one-shot migration
// would not.
//
// Fail closed: a dictionary that never loads still answers every dictGet
// with the caller's default (see identity/dictionaries.ts), so identity
// resolution degrades to the anonymous id silently. That is worse than not
// starting, so this follows the exact same fatal-log-and-exit pattern as the
// migration failure above rather than logging a warning and continuing.
//
// Logging `err` directly here is safe, not merely convenient:
// ensureIdentityDictionaries() already strips the Postgres password out of
// any failure before it rethrows (see sanitizeDictionaryError in
// identity/dictionaries.ts), so this call site does not need to — and must
// not — do any redaction of its own.
try {
  await ensureIdentityDictionaries(ch, parsePgUrl(config.pgUrl))
  app.log.info('identity dictionaries ready')
} catch (err) {
  app.log.fatal({ err }, 'could not create identity dictionaries')
  await flushLogger(app.log, LOG_FLUSH_TIMEOUT_MS)
  process.exit(1)
}

// counters.flush() never rejects — failures surface through the onError
// callback buildApp already wired to the Fastify logger — so this
// fire-and-forget interval can never become an unhandled rejection.
setInterval(() => void app.deps.counters.flush(), 10_000).unref()

// Bootstrap runs after migrations (013 must exist) and before listen, so
// that the first request never races the admin row's creation. It is not
// fatal on failure to configure -- an install upgrading from a build with
// no admin account has no password in its .env, and must still boot. See
// auth/bootstrap.ts.
const adminOutcome = await ensureAdminUser(pg, {
  email: config.adminEmail,
  password: config.adminPassword,
})
if (adminOutcome === 'created') {
  app.log.info('admin account created from LYRAFLOW_ADMIN_EMAIL/LYRAFLOW_ADMIN_PASSWORD')
} else if (adminOutcome === 'not_configured') {
  // Names the containerised invocation, not a bare `lyraflow`: the documented
  // install path puts no such binary on the host's PATH, so the old wording
  // sent an operator to a command that does not exist (#129). Kept to one line
  // because it is a log record rather than the instruction itself -- the full
  // form, with `-T` and a password read off the terminal, is on the sign-in
  // screen and in the README.
  app.log.warn(
    'no admin account and none configured — the web UI cannot be signed into until `docker compose exec -T lyraflow node packages/cli/dist/index.js set-admin-password <email>` is run (or `lyraflow set-admin-password <email>` if not running under Docker)',
  )
}

// Started only after the dictionaries are up: a purge resolves identity from
// Postgres and does not need them, but a process that failed either boot step
// exits, and starting a timer that outlives that decision is pointless.
app.deps.purge.start()
app.deps.sessionSweeper.start()
// A project purge does not resolve identity either, but for the same
// reason as `purge` above: no point starting a timer that outlives a boot
// that already failed.
app.deps.projectPurge.start()

// Same reasoning as purge above, plus one more: off is a legitimate choice
// for an operator managing retention some other way, but silently doing
// nothing would not be — so the disabled path logs once, here, at startup,
// making the choice visible rather than merely absent.
if (config.retentionEnabled) {
  app.deps.retention.start()
} else {
  app.log.info(
    "retention disabled (LYRAFLOW_RETENTION_ENABLED=false) — no events will be dropped for age; retention is nobody's job unless something else does it",
  )
}

await app.listen({ port: config.port, host: '0.0.0.0' })
readiness.markReady()
