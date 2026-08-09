#!/usr/bin/env node
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { UsageError, hasRawFlag, parseCommandArgs } from './api/args.js'
import { Client } from './api/client.js'
import { runEvents } from './api/commands/events.js'
import { runStats } from './api/commands/stats.js'
import type { CommandContext } from './api/context.js'
import {
  CLI_VERSION,
  OUTPUT_SCHEMA_VERSION,
  emitError,
  emitObject,
  resolveMode,
} from './api/output.js'
import { ProjectExistsError, createProject } from './create-project.js'

// Re-exported so existing call sites (`import type { CommandContext } from
// './index.js'`) keep working — the interface itself lives in
// api/context.ts now; see that file's docstring for why.
export type { CommandContext } from './api/context.js'

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
      // `runVersion` never touches `client`/`writeErr`/`now`/`sleep` — the
      // client is built with placeholder config purely to satisfy the
      // shared `CommandContext` shape; constructing a `Client` does no I/O
      // and never validates its config (see client.ts), so this is safe
      // even with no real host/key configured.
      await runVersion(args, {
        client: new Client({ host: '', serverKey: '' }),
        write: (s) => process.stdout.write(s),
        writeErr: (s) => process.stderr.write(s),
        isTty: process.stdout.isTTY ?? false,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

    case 'events':
    case 'stats': {
      const isTty = process.stdout.isTTY ?? false
      const write = (s: string) => {
        process.stdout.write(s)
      }
      const writeErr = (s: string) => {
        process.stderr.write(s)
      }

      // `||`, not `??`: an explicit but empty `--host=`/`--server-key=`
      // must fall back to the env var too, not silently win as `''` — a
      // Client built with an empty host fails later with a confusing URL
      // error instead of this branch's clear "must be set" message.
      const host = extractOverride(args, 'host') || process.env.LYRAFLOW_HOST
      const serverKey = extractOverride(args, 'server-key') || process.env.LYRAFLOW_SERVER_KEY
      if (!host || !serverKey) {
        // process.exitCode, not process.exit(2): see the create-project
        // case above for why — the writeErr call just above this needs to
        // actually flush before the process ends.
        //
        // hasRawFlag, not `resolveMode({}, isTty)`: this branch runs
        // before either command's own parse ever does, so a --json in argv
        // must still be honoured here too — the exact gap events.ts's and
        // stats.ts's own parse-failure paths were fixed for earlier, just
        // one dispatch layer up.
        emitError(
          new UsageError(
            'LYRAFLOW_HOST and LYRAFLOW_SERVER_KEY must be set (or pass --host/--server-key)',
          ),
          resolveMode({ json: hasRawFlag(args, 'json'), human: hasRawFlag(args, 'human') }, isTty),
          writeErr,
        )
        process.exitCode = 2
        break
      }

      const ctx: CommandContext = {
        client: new Client({ host, serverKey }),
        isTty,
        write,
        writeErr,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }
      process.exitCode =
        command === 'events' ? await runEvents(args, ctx) : await runStats(args, ctx)
      break
    }

    default:
      console.error('Usage: lyraflow <--version|migrate|create-project|healthcheck|events|stats>')
      process.exit(2)
  }
}

/**
 * A deliberately small, hand-rolled scan for `--host`/`--server-key` —
 * NOT `parseCommandArgs`, because that runs in `strict` mode and would
 * reject every other flag a specific command accepts (`--since`,
 * `--follow`, ...) that this dispatch layer has no reason to know about.
 * This only extracts the two flags that decide which server to talk to,
 * before the command's own (fuller) parse runs; a repeated flag keeps the
 * last occurrence, the same convention `parseCommandArgs` itself uses.
 *
 * Stops at a bare `--`, the same "everything after this is positional"
 * convention `node:util`'s `parseArgs` (and this file's own commands, via
 * `hasRawFlag`) honour — without this, `events --host H -- --server-key K`
 * would have this scanner treat a deliberate positional as the real
 * override, disagreeing with what the strict command-level parser sees.
 */
export function extractOverride(args: string[], flag: string): string | undefined {
  const prefix = `--${flag}=`
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (arg === `--${flag}`) {
      value = args[i + 1]
    } else if (arg?.startsWith(prefix)) {
      value = arg.slice(prefix.length)
    }
  }
  return value
}

/**
 * Handles the failure mode `events.ts`'s/`stats.ts`'s own synchronous
 * `isEpipe` guards CANNOT: `process.stdout.write()` on a pipe is
 * asynchronous. When the reader closes early (a real `| head`), Node does
 * NOT throw synchronously from `write()` — the failure arrives later as an
 * `'error'` event on the underlying socket, after `write()` has already
 * returned, which no `try`/`catch` around a `write` call can ever observe.
 * Confirmed directly against a real subprocess piped into a reader that
 * closes early (index.epipe.test.ts): the crash is `Emitted 'error' event
 * on Socket instance`, not a thrown exception anywhere in this codebase's
 * own call stack. This handler is the one place that failure can be
 * caught at all — global, not per-command, which is deliberate: a broken
 * pipe on stdout means the same thing (the reader is gone, stop cleanly)
 * regardless of which subcommand was writing when it happened.
 *
 * Any OTHER stdout error (not EPIPE — a full disk, say) is NOT swallowed:
 * it rethrows, which Node's default `'error'`-event handling turns into an
 * uncaught exception and a non-zero exit, the same as if this listener had
 * never been installed. index.epipe.test.ts confirms this with a second,
 * ordinary failure (a missing required env var for `migrate`) still
 * exiting non-zero with this handler installed — the handler only ever
 * changes behaviour on the one error code it names.
 */
function installStdoutEpipeGuard(): void {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0)
    }
    throw err
  })
}

// Runs `main()` only when this file is the process entry point (`node
// dist/index.js`, or the `lyraflow` bin symlink to it) — never on import.
// Without this guard, importing the module to reach `runVersion` and
// `CommandContext` for testing would also execute the switch above against
// the test runner's own `process.argv`, which is not this CLI's argv at
// all — and would attach a real `process.stdout` listener onto the test
// runner's own process for every test file that imports this module.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  installStdoutEpipeGuard()
  await main()
}
