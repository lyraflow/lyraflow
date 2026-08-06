#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'

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
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const writeKey = `wk_${randomBytes(16).toString('hex')}`
    const serverKey = `sk_${randomBytes(24).toString('hex')}`
    await pg.query(
      'INSERT INTO projects (name, slug, write_key, server_key_hash) VALUES ($1, $2, $3, $4)',
      [name, slug, writeKey, createHash('sha256').update(serverKey).digest('hex')],
    )
    console.log(`Project "${name}" created.`)
    console.log(`  Write key  (public, safe in browser JS): ${writeKey}`)
    console.log(`  Server key (secret, shown once):         ${serverKey}`)
    await pg.end()
    await ch.close()
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
