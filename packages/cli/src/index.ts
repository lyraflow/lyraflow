#!/usr/bin/env node
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { SCHEMA_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { UsageError, hasRawFlag, parseCommandArgs } from './api/args.js'
import { Client } from './api/client.js'
import { runDeletions, runSchema, runSegments } from './api/commands/catalog.js'
import { runEvents } from './api/commands/events.js'
import { runPersons } from './api/commands/persons.js'
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
 * How long `createPrompt` waits for an answer before giving up and
 * declining on the caller's behalf. Exported so a test can assert its real
 * value directly rather than hard-coding it a second time; `createPrompt`
 * itself takes an overridable `timeoutMs` so a test does not have to wait
 * the real two minutes to prove the backstop fires.
 *
 * Two minutes, per review: generous enough that a real human confirming a
 * genuinely destructive action is never cut off mid-thought, short enough
 * that an unattended, silent stdin (see `createPrompt`'s own docstring for
 * why `stdinIsTty` alone cannot rule this out) does not tie up a caller
 * indefinitely either.
 */
export const PROMPT_TIMEOUT_MS = 2 * 60_000

/**
 * The real, process-wide implementation of `CommandContext['prompt']` —
 * `persons delete`'s only route to an interactive "are you sure" question.
 * Writes the question to STDERR (never stdout — a prompt is not a record),
 * reads one line from stdin, and answers `true` only for `y`/`yes`
 * (case-insensitive); anything else, INCLUDING no answer at all in any of
 * the shapes below, is a decline.
 *
 * MUST NOT HANG, and "the input stream closed" turned out to be only ONE
 * of the ways it can stop producing an answer — a review round on this
 * exact function found the other two by testing against a real pty, which
 * is how most agent harnesses (tmux, `script`, most agent runners) run a
 * CLI, and where `stdinIsTty` is commonly TRUE, defeating the
 * `!stdinIsTty` guard `runDelete` (persons.ts) uses to skip prompting
 * altogether:
 *
 *   1. `input.end()` — a clean close. `rl`'s own `'close'` event fires.
 *      Handled since the first version of this function.
 *   2. `input.destroy()` with no error — the stream tears down WITHOUT ever
 *      emitting `'end'`, so `rl`'s `'close'` (which fires off of `'end'`)
 *      never fires either. `rl` alone hangs forever here. Closed by
 *      listening for `input`'s OWN `'close'` event directly, not only
 *      `rl`'s.
 *   3. `input.destroy(err)` — emits `'error'` before `'close'`. An
 *      unhandled `'error'` event is itself an uncaught exception in Node,
 *      so this needs an explicit listener both to resolve `false` AND to
 *      stop that crash — two different failures from one gap. Confirmed
 *      empirically that ONE listener is not enough: `readline` internally
 *      attaches its own handler to `input`'s `'error'` event and RE-EMITS
 *      it on the `rl` Interface object itself — `input.on('error', ...)`
 *      satisfies `input`'s own no-listener check, but does nothing for
 *      that separate re-emission, which crashed the process even with
 *      `input`'s own listener present until `rl.on('error', ...)` was
 *      added too.
 *   4. The one no stream event can ever announce: input that simply never
 *      produces anything at all — no data, no close, no error, ever (a pty
 *      allocated but nothing typed into it). No listener fires for
 *      "nothing is happening"; only a bounded timeout can end this one.
 *      `PROMPT_TIMEOUT_MS` is the backstop for exactly this case, and
 *      writes an explicit message to `output` when it fires so a caller
 *      reading the transcript later knows the answer was "no reply", not
 *      a real decline.
 *
 * `input`/`output` default to the real `process.stdin`/`process.stderr` —
 * overridable so index.test.ts can prove all four endings above against a
 * fake stream instead of the real process's stdin, which a test runner
 * does not control the same way. `timeoutMs` defaults to
 * `PROMPT_TIMEOUT_MS`, overridable so a test can prove the timeout backstop
 * itself without a real two-minute wait.
 */
export function createPrompt(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  timeoutMs: number = PROMPT_TIMEOUT_MS,
): (question: string) => Promise<boolean> {
  return (question: string) =>
    new Promise<boolean>((resolve) => {
      const rl = createInterface({ input, output })
      let settled = false

      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.removeListener('close', onInputClose)
        input.removeListener('error', onInputError)
        rl.removeListener('error', onRlError)
        rl.close()
        resolve(value)
      }

      // `rl`'s OWN 'close' — fires off input's 'end' (ending #1 above).
      rl.once('close', () => finish(false))
      // `input`'s 'close' directly — ending #2, which never reaches `rl`'s
      // own 'close' at all (destroy() with no error skips 'end' entirely).
      const onInputClose = () => finish(false)
      input.on('close', onInputClose)
      // Ending #3 (`destroy(err)`) needs TWO listeners, not one — confirmed
      // empirically, the hard way: `readline` internally attaches its own
      // listener to `input`'s 'error' event and RE-EMITS it on the `rl`
      // Interface object itself. `input.on('error', ...)` below satisfies
      // `input`'s own requirement (an EventEmitter only throws on 'error'
      // when NOTHING is listening), but does nothing for the SEPARATE
      // re-emission on `rl` — that needs its own listener, or Node throws
      // an uncaught exception from `rl`'s emission specifically, not
      // `input`'s. Without `rl.on('error', ...)`, this ending crashed the
      // process, even though `input.on('error', ...)` was already present.
      const onInputError = () => finish(false)
      const onRlError = () => finish(false)
      input.on('error', onInputError)
      rl.on('error', onRlError)

      // Ending #4: nothing happens, ever. The backstop of last resort —
      // see the module docstring for why no stream event can substitute
      // for this.
      const timer = setTimeout(() => {
        try {
          output.write(
            `\n(no reply within ${Math.round(timeoutMs / 1000)}s; treating as declined — nothing was deleted)\n`,
          )
        } catch {
          // A broken output stream at this point changes nothing about
          // the answer this resolves to — `finish(false)` runs either way.
        }
        finish(false)
      }, timeoutMs)

      rl.question(`${question} [y/N] `, (answer) => {
        finish(/^y(es)?$/i.test(answer.trim()))
      })
    })
}

/**
 * The real `CommandContext['sleep']` for `events --follow` — identical to a
 * plain `setTimeout`-based sleep except that it also rejects the moment
 * `signal` aborts. `events.ts`'s own `--follow` loop already has a catch
 * block for a rejected sleep (see its module docstring: "a cancelled sleep
 * ... ends the follow session cleanly ... still exits 0" and writes the
 * resume cursor first) — that path existed and was tested since Task 8/9,
 * but nothing in the real dispatch below ever rejected `sleep` to reach it.
 * A real SIGINT during `--follow` fell through to Node's own default signal
 * handling instead: an immediate, uncatchable kill with no exit code at all
 * (a shell reports 130) and the resume cursor never written — confirmed
 * against the built binary before this existed. This function, plus the
 * `AbortController` wired to SIGINT/SIGTERM below, is what makes the
 * already-tested catch path reachable for real.
 *
 * KNOWN GAP, not fixed here: if the signal arrives while a poll's own HTTP
 * request is still in flight — rather than during the sleep between polls —
 * this cannot cancel that request; `Client` (client.ts) takes no
 * `AbortSignal` today. The loop only notices the abort once that request
 * settles and it reaches the next `ctx.sleep` call, so the exit is bounded
 * by that request's latency, not instant. Cancelling an in-flight request is
 * a change to the whole HTTP client, not to signal wiring, and is out of
 * scope here.
 */
export function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('interrupted'))
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('interrupted'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Wires SIGINT/SIGTERM to `controller` — but ONLY for `events --follow`,
 * never for any other command or for `events` without `--follow`. `sleep`
 * (`CommandContext`) is read only by that one loop (see its own docstring);
 * a handler that merely aborts a controller nothing else ever checks would
 * be a silent no-op for every other command while still disabling Node's
 * own default SIGINT/SIGTERM handling for it — trading one hang for
 * another. Gated on a raw pre-scan of `argv` (`hasRawFlag`, the same
 * convention `extractOverride`/the `--json` pre-scans below already use),
 * not on `runEvents`'s own parsed flags, because the wiring has to exist
 * BEFORE that parse runs.
 *
 * `process.once`, not `process.on`: the FIRST signal aborts the controller
 * and gives the follow loop a chance to unwind cleanly through its own
 * `ctx.sleep` catch (see `abortableSleep`'s docstring for the one case that
 * can delay it — an in-flight request). A SECOND signal, if the first one
 * hasn't ended the process yet, finds no listener left for that event and
 * falls through to Node's own default kill — the same escape hatch a hung
 * process always has, deliberately not replaced with a bespoke force-exit
 * timer that would need its own timeout tuned against production latency.
 */
function wireFollowInterrupt(argv: string[]): AbortController {
  const controller = new AbortController()
  if (hasRawFlag(argv, 'follow')) {
    const onSignal = () => controller.abort()
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  }
  return controller
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
        stdinIsTty: process.stdin.isTTY ?? false,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // runVersion never prompts — placeholder to satisfy CommandContext's
        // shape, same reasoning as the placeholder Client just above.
        prompt: () => Promise.resolve(false),
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
    case 'stats':
    case 'persons':
    case 'deletions':
    case 'segments':
    case 'schema': {
      const isTty = process.stdout.isTTY ?? false
      const stdinIsTty = process.stdin.isTTY ?? false
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

      // Only 'events' ever defines --follow, and wireFollowInterrupt is
      // itself a no-op (no signal listeners installed) unless --follow is
      // actually present in argv — see its own docstring for why this must
      // not run for the other five commands, or for a plain `events` call
      // with no --follow.
      const followAbort = command === 'events' ? wireFollowInterrupt(args) : new AbortController()

      const ctx: CommandContext = {
        client: new Client({ host, serverKey }),
        isTty,
        stdinIsTty,
        write,
        writeErr,
        now: () => new Date(),
        sleep: abortableSleep(followAbort.signal),
        // Built once per invocation, real stdin/stderr — only `persons
        // delete` (via runPersons) ever actually calls this; every other
        // command here never reaches it, the same way `stats` never reads
        // `sleep`.
        prompt: createPrompt(),
      }
      switch (command) {
        case 'events':
          process.exitCode = await runEvents(args, ctx)
          break
        case 'stats':
          process.exitCode = await runStats(args, ctx)
          break
        case 'persons':
          process.exitCode = await runPersons(args, ctx)
          break
        case 'deletions':
          process.exitCode = await runDeletions(args, ctx)
          break
        case 'segments':
          process.exitCode = await runSegments(args, ctx)
          break
        case 'schema':
          process.exitCode = await runSchema(args, ctx)
          break
      }
      break
    }

    default:
      console.error(
        'Usage: lyraflow <--version|migrate|create-project|healthcheck|events|stats|persons|deletions|segments|schema>',
      )
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
