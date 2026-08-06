#!/usr/bin/env node
import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { ProjectExistsError, createProject } from './create-project.js'

function env(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required environment variable: ${key}`)
  return v
}

function clients() {
  return {
    pg: createPgPool(env('LYRAFLOW_POSTGRES_URL')),
    ch: createChClient({
      url: env('LYRAFLOW_CLICKHOUSE_URL'),
      username: env('LYRAFLOW_CLICKHOUSE_USER'),
      password: env('LYRAFLOW_CLICKHOUSE_PASSWORD'),
      database: env('LYRAFLOW_CLICKHOUSE_DB'),
    }),
  }
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'migrate': {
    const { pg, ch } = clients()
    const dir = join(import.meta.dirname, '..', '..', 'db', 'migrations')
    const { applied } = await migrate({
      pg,
      ch,
      migrations: loadMigrations(dir),
      appSchemaVersion: SCHEMA_VERSION,
    })
    console.log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Already up to date.',
    )
    await pg.end()
    await ch.close()
    break
  }

  case 'create-project': {
    const name = args[0]
    if (!name) {
      console.error('Usage: lyraflow create-project <name>')
      process.exit(2)
    }
    const { pg, ch } = clients()
    try {
      const project = await createProject(pg, name)
      console.log(`Project "${project.name}" created.`)
      console.log(`  Write key  (public, safe in browser JS): ${project.writeKey}`)
      console.log(`  Server key (secret, shown once):         ${project.serverKey}`)
    } catch (err) {
      if (!(err instanceof ProjectExistsError)) throw err
      console.error(err.message)
      // process.exitCode, not process.exit(1): exit() can truncate a stderr
      // write that has not flushed yet (stderr is asynchronous when it is a
      // pipe, which is exactly what `docker compose exec … | tee` gives you),
      // and the message is the entire point of this branch. Closing the
      // clients below lets the process end on its own with this code.
      process.exitCode = 1
    } finally {
      await pg.end()
      await ch.close()
    }
    break
  }

  case 'healthcheck': {
    const url = process.env.LYRAFLOW_URL ?? 'http://localhost:3000'
    const res = await fetch(`${url}/ready`)
    console.log(res.ok ? 'ready' : `not ready (${res.status})`)
    process.exit(res.ok ? 0 : 1)
    break
  }

  default:
    console.error('Usage: lyraflow <migrate|create-project|healthcheck>')
    process.exit(2)
}
