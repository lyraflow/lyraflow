import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { buildApp } from './app.js'
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

await app.listen({ port: config.port, host: '0.0.0.0' })
readiness.markReady()
