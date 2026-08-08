#!/usr/bin/env node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { parseCommandArgs } from './api/args.js'
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION, emitObject, resolveMode } from './api/output.js'
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

/**
 * What a command handler needs from the outside world, kept deliberately
 * small — this task only needs `write` and `isTty` for `runVersion`. Task 7
 * (wiring the read/privacy commands) extends this rather than replacing it;
 * see the CLI task 6 report for the reasoning.
 */
export interface CommandContext {
  /** Where output goes. Never `console.log`/`console.error` directly from a
   * command handler — writing through this is what lets a test capture
   * output without touching real stdout, and what would let a future
   * caller redirect it (e.g. to stderr for an error path) in one place. */
  write: (s: string) => void
  /** Whether the destination is a real terminal — `resolveMode`'s second
   * argument, threaded through here so a test can fake it without a real
   * TTY. */
  isTty: boolean
}

/**
 * `lyraflow --version` — how an agent learns which JSON contract it is
 * talking to before trusting any field name. Reports two numbers that move
 * for different reasons: `version` (CLI_VERSION) moves with every release;
 * `output_schema` (OUTPUT_SCHEMA_VERSION) moves only when a documented JSON
 * field changes shape or meaning, which is the one that actually matters
 * for deciding whether to trust the output.
 */
export async function runVersion(args: string[], ctx: CommandContext): Promise<void> {
  const { flags } = parseCommandArgs(args, { booleans: ['json', 'human'] })
  const mode = resolveMode(flags, ctx.isTty)
  emitObject({ version: CLI_VERSION, output_schema: OUTPUT_SCHEMA_VERSION }, mode, ctx.write)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)

  switch (command) {
    case '--version': {
      await runVersion(args, {
        write: (s) => process.stdout.write(s),
        isTty: process.stdout.isTTY ?? false,
      })
      break
    }

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
      console.error('Usage: lyraflow <--version|migrate|create-project|healthcheck>')
      process.exit(2)
  }
}

// Runs `main()` only when this file is the process entry point (`node
// dist/index.js`, or the `lyraflow` bin symlink to it) — never on import.
// Without this guard, importing the module to reach `runVersion` and
// `CommandContext` for testing would also execute the switch above against
// the test runner's own `process.argv`, which is not this CLI's argv at
// all.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  await main()
}
