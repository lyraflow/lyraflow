import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { Readiness } from './health.js'
import { installShutdownHandlers } from './shutdown.js'

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
// upgrade procedure. The advisory lock makes concurrent starts safe.
const migrationsDir = join(import.meta.dirname, '..', '..', 'db', 'migrations')
const { applied } = await migrate({
  pg,
  ch,
  migrations: loadMigrations(migrationsDir),
  appSchemaVersion: SCHEMA_VERSION,
})
app.log.info({ applied }, 'migrations complete')

// counters.flush() never rejects — failures surface through the onError
// callback buildApp already wired to the Fastify logger — so this
// fire-and-forget interval can never become an unhandled rejection.
setInterval(() => void app.deps.counters.flush(), 10_000).unref()

await app.listen({ port: config.port, host: '0.0.0.0' })
readiness.markReady()
