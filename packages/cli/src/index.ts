#!/usr/bin/env node
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { ProjectExistsError, SCHEMA_VERSION, createProject } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { UsageError, hasRawFlag, parseCommandArgs } from './api/args.js'
import { Client } from './api/client.js'
import { runDeletions, runSchema, runSegments } from './api/commands/catalog.js'
import {
  checkNoPositionals,
  checkStrayFlags,
  reportParseFailure,
  reportUsageError,
} from './api/commands/command-support.js'
import { runEvents } from './api/commands/events.js'
import { runFunnels } from './api/commands/funnels.js'
import { runPersons } from './api/commands/persons.js'
import { runSnippet } from './api/commands/snippet.js'
import { runStats } from './api/commands/stats.js'
import { runUsage } from './api/commands/usage.js'
import type { CommandContext } from './api/context.js'
import {
  CLI_VERSION,
  OUTPUT_SCHEMA_VERSION,
  emitError,
  emitObject,
  resolveMode,
} from './api/output.js'
import { runSeedDemo } from './seed/command.js'
import {
  EmptyPasswordError,
  StdinTimeoutError,
  readAllStdin,
  setAdminPassword,
} from './set-admin-password.js'

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
 * `signal` aborts, so a follow loop sitting between polls unwinds through
 * its own cancelled-sleep catch instead of waiting out the remaining delay.
 *
 * THIS IS NOT WHAT ENDS THE PROCESS ON A SIGNAL, and a version of this file
 * that believed it was shipped a Critical: a `--follow` session spends most
 * of its life awaiting an HTTP request, not this sleep, and an abort nobody
 * is awaiting is an abort nobody observes. `wireFollowInterrupt` below is
 * what actually ends the process, promptly, from whichever await the loop
 * happens to be sitting on.
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
 * A stderr write that is finished by the time it returns. `process.stderr`
 * is asynchronous on POSIX whenever it is a pipe — which is how an agent
 * harness, `docker compose exec … | tee`, and this repo's own subprocess
 * tests all run this CLI — so a `process.stderr.write` issued immediately
 * before `process.exit` is queued and then dropped. The lines that must
 * survive an interrupt go through here instead.
 *
 * CALL THIS ONCE, WITH EVERYTHING THAT MUST SHARE FATE IN ONE STRING, most
 * important line FIRST. Two calls are two independent outcomes, and on a
 * congested pipe the shorter one wins — which is how a review found a
 * `--follow` interrupt writing its resume cursor while the truncation
 * warning that invalidates it was lost, under nothing more exotic than
 * `2>&1`. POSIX makes a write of at most PIPE_BUF (4096) bytes to a pipe
 * ATOMIC: all of it, or `EAGAIN` on a non-blocking fd — it never writes
 * part. Measured directly, with 100 bytes of room left in the pipe's tail
 * page: the 149-byte warning failed `EAGAIN` and the 21-byte cursor
 * succeeded, alone. One 170-byte write in its place can only succeed or
 * fail as a unit. Above PIPE_BUF a partial write becomes possible again,
 * but a partial write is a PREFIX — so "most important first" keeps the
 * guarantee at any size: a later line can never appear without the earlier
 * one complete.
 *
 * Falls back to the ordinary async write if `writeSync` fails; a
 * best-effort line beats none, and a stderr that cannot be written at all
 * changes nothing about the exit. (The fallback is queued, so it is usually
 * dropped by the exit that follows — it is the last resort, not the plan.)
 */
function writeErrSync(s: string): void {
  if (s.length === 0) return
  try {
    writeSync(2, s)
  } catch {
    try {
      process.stderr.write(s)
    } catch {
      // Nothing left to try, and nothing that depends on it.
    }
  }
}

/**
 * How long an interrupted `--follow` will wait for stdout's own backlog to
 * reach the reader before giving up and exiting anyway. Bounds the wait on
 * something entirely under the CALLER's control (their reader), never on
 * the server — an in-flight request is abandoned instantly regardless.
 *
 * Two seconds: the same order as the poll interval, so it is invisible to a
 * human who pressed Ctrl-C, and far longer than any reader that is actually
 * reading needs. A reader that has gone away instead produces EPIPE, which
 * `installStdoutEpipeGuard` already turns into an immediate clean exit.
 */
const STDOUT_FLUSH_GRACE_MS = 2000

/** Written to stderr, before the resume cursor and in the SAME write (see
 * `writeErrSync`), when the grace above runs out — so a truncated record
 * stream is never silently reported as a clean exit 0, and a caller can
 * never receive the cursor without the warning that says not to trust it. */
const STDOUT_TRUNCATED_LINE =
  '{"warning":"interrupted while output was still being written; some records may not have reached the reader, so the next_cursor below may skip them"}'

/** What `main` hands a command so it can be interrupted — see
 * `wireFollowInterrupt`. */
interface FollowInterrupt {
  signal: AbortSignal
  onInterrupt: (handler: (writeErrNow: (s: string) => void) => void) => void
  /** True from the instant a signal is received. `main` routes the ordinary
   * `write`/`writeErr` through this so a command cannot keep writing after
   * the interrupt has already decided what was delivered — see
   * `wireFollowInterrupt`'s docstring on why that is a correctness
   * requirement and not just tidiness. */
  interrupted: () => boolean
}

/**
 * Wires SIGINT/SIGTERM to an immediate, cursor-preserving shutdown — but
 * ONLY for `events --follow`, never for any other command or for `events`
 * without `--follow`. Installing a listener SUPPRESSES NODE'S OWN DEFAULT
 * KILL for that signal, so wiring one for a command that does not act on it
 * does not merely do nothing: it makes that command unkillable by the
 * signal a human or an init system actually sends. Gated on a raw pre-scan
 * of `argv` (`hasRawFlag`, the same convention `extractOverride`/the
 * `--json` pre-scans below already use), not on `runEvents`'s own parsed
 * flags, because the wiring has to exist BEFORE that parse runs.
 *
 * ONE SIGNAL IS ALWAYS ENOUGH. The handler does not wait for anything —
 * not the in-flight HTTP request, not the sleep between polls — because
 * there is nothing to wait for: the resume cursor is known inside the loop
 * at all times, and a registered `onInterrupt` handler hands it over
 * synchronously. The previous design instead aborted a controller and hoped
 * the loop would notice, which it could only do from `ctx.sleep`; a signal
 * arriving during a poll's own request was consumed by this listener and
 * discarded, leaving the process alive for up to undici's 301-second
 * `headersTimeout` and requiring a SECOND signal (of the same kind — a
 * SIGINT after a SIGTERM found the SIGTERM listener already spent and the
 * SIGINT one still installed, so mixed pairs survived both) to die at all.
 * Measured against a server that accepts the connection and never answers,
 * before the fix: `INT` alone, `INT`+`TERM` and `TERM`+`INT` all survived
 * past 8 seconds and had to be SIGKILLed.
 *
 * Exits 0, the same code a `--follow` session that stops any other way
 * reports, and the code packages/cli/README.md documents: an interrupted
 * tail is a normal end, not a failure. Handlers run before the exit, in
 * registration order, each guarded so that one throwing cannot stop the
 * others or the exit itself.
 *
 * THE ONE THING IT DOES WAIT FOR — and the regression the first version of
 * this fix introduced. `process.exit` drops whatever `process.stdout` has
 * buffered, and on POSIX stdout is asynchronous when it is a pipe, so a
 * reader slower than the CLI is writing leaves real records queued.
 * Measured: a 500-record page into a reader that had not started consuming,
 * interrupted mid-poll, delivered 148 of 500 — and then wrote a resume
 * cursor positioned AFTER the 352 that never arrived, so `--after` would
 * skip them permanently. Silent loss, reported as exit 0, in the command
 * whose entire promise is "no event twice, none missed". The previous
 * sleep-cancellation design did not have this, because it unwound normally
 * and Node flushed on its way out.
 *
 * So: flush stdout first, then write the cursor, then exit. Bounded by
 * `STDOUT_FLUSH_GRACE_MS`, because "one signal is enough" must stay
 * literally true even against a reader that never reads again — and if that
 * bound is ever hit, the truncation is REPORTED rather than silent, so a
 * caller knows not to trust the cursor that follows it. This waits on the
 * caller's own reader, never on the server: an in-flight request is still
 * abandoned instantly, which is the whole point of the fix.
 *
 * THAT REPORT AND THE CURSOR SHARE ONE WRITE. Issued separately they have
 * independent fates, and on a congested pipe the shorter one wins: measured
 * under `2>&1` with a reader 2s behind, the cursor arrived and the warning
 * did not — reinstating exactly the failure the flush exists to prevent,
 * because a cursor with no warning is worse than no cursor at all. See
 * `writeErrSync` for the PIPE_BUF atomicity this rests on.
 *
 * HANDLERS ARE RUN AT SIGNAL TIME, AND THEIR OUTPUT IS HELD UNTIL THE EXIT.
 * Not for tidiness — two reasons, both correctness. (1) The follow loop can
 * still be running during the grace, and its own cancelled-sleep catch
 * writes the same cursor, so a caller reading stderr saw `next_cursor`
 * twice; snapshotting here plus suppressing command-level writes (see
 * `interrupted`) leaves exactly one authoritative line. (2) If the loop's
 * in-flight request happens to land during the grace, it would emit new
 * records and advance `cursor` — and a cursor read at exit time would then
 * point PAST records this process is about to stop waiting to deliver.
 * Reading it at signal time pins it to what was actually emitted, and makes
 * the backlog and no-backlog paths behave identically.
 */
function wireFollowInterrupt(argv: string[]): FollowInterrupt {
  const controller = new AbortController()
  const handlers: ((writeErrNow: (s: string) => void) => void)[] = []
  let interrupting = false

  if (hasRawFlag(argv, 'follow')) {
    const onSignal = () => {
      // First, and before anything can write again: from here on the
      // interrupt owns the output. `main`'s `write`/`writeErr` become
      // no-ops, so the follow loop cannot duplicate the cursor this handler
      // is about to snapshot, nor append records to a backlog whose size we
      // have already decided to stop waiting on.
      interrupting = true
      // Stops the loop starting any further work. `process.exit` below is
      // what actually ends this process, but if this handler is ever
      // changed to return instead, an aborted signal still makes the follow
      // loop unwind through its own cancelled-sleep catch rather than poll
      // on forever with nobody listening.
      controller.abort()

      // Snapshotted NOW, at the instant of the signal — see the docstring
      // for the two things that go wrong if this is read at exit time
      // instead, and binary.test.ts's "reports the cursor as it stood at
      // the signal" for the one that is reachable in practice.
      const pending: string[] = []
      for (const handler of handlers) {
        try {
          handler((s) => {
            pending.push(s)
          })
        } catch {
          // A handler that throws must not cost the exit, nor the other
          // handlers' chance to say what they know.
        }
      }

      let settled = false
      // A holder, not a bare `let`: `finish` is declared before the timer
      // exists and has to be able to clear it, and `finish` can also run
      // before the timer is ever created (the nothing-pending path below).
      const grace: { timer?: ReturnType<typeof setTimeout> } = {}
      const finish = (flushed: boolean) => {
        if (settled) return
        settled = true
        if (grace.timer !== undefined) clearTimeout(grace.timer)
        // ONE write, warning first — the two must share fate. See
        // `writeErrSync`.
        writeErrSync(`${flushed ? '' : `${STDOUT_TRUNCATED_LINE}\n`}${pending.join('')}`)
        process.exit(0)
      }

      // The overwhelmingly common case — between polls, or with a reader
      // keeping up — is nothing pending at all, and takes the immediate
      // path with no timer and no waiting.
      if (process.stdout.writableLength === 0) {
        finish(true)
        return
      }
      grace.timer = setTimeout(() => finish(false), STDOUT_FLUSH_GRACE_MS)
      try {
        // A zero-length write whose callback fires once everything queued
        // ahead of it has been handed to the OS — writes complete in order,
        // so this is "tell me when the backlog is gone" without reaching
        // into the stream's internals or polling `writableLength`.
        process.stdout.write('', () => finish(true))
      } catch {
        finish(false)
      }
    }
    // `process.on`, not `process.once`: the handler exits the process, so a
    // second delivery is unreachable in practice — but a listener that
    // removes itself before it has exited is a window where a signal
    // arriving in that instant would fall through to a default kill and
    // lose the cursor. There is no such window this way.
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }

  return {
    signal: controller.signal,
    interrupted: () => interrupting,
    onInterrupt: (handler) => {
      handlers.push(handler)
    },
  }
}

/**
 * `lyraflow --version` — how an agent learns which JSON contract it is
 * talking to before trusting any field name. Reports two numbers that move
 * for different reasons: `version` (CLI_VERSION) moves with every release;
 * `output_schema` (OUTPUT_SCHEMA_VERSION) moves only when a documented JSON
 * field changes shape or meaning, which is the one that actually matters
 * for deciding whether to trust the output.
 *
 * Returns the process exit code, like every other command handler: 0, or 2
 * for a usage error. It did not, and did not catch a failed parse either,
 * until the final Plan 7 review — a seam, not a decision: `runVersion` came
 * from Task 6 and `reportParseFailure` was extracted in Task 7 for the six
 * command groups, and nobody came back. `lyraflow --version --unknown-flag`
 * printed a raw `UsageError` stack trace and exited 1 where the contract
 * says 2 and JSON under `--json`. That matters more here than anywhere
 * else: this is the command the README tells an agent to run FIRST, to read
 * `output_schema` before trusting any field name, and `--host` — accepted
 * by all six other commands — is the obvious thing for an operator to reach
 * for. It is still rejected here (this command talks to nothing, and a flag
 * silently accepted and ignored is the failure `checkStrayFlags` exists to
 * prevent), but now as an ordinary usage error.
 */
export async function runVersion(args: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  try {
    ;({ flags } = parseCommandArgs(args, { booleans: ['json', 'human'] }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, args, ctx)
  }
  const mode = resolveMode(flags, ctx.isTty)
  emitObject({ version: CLI_VERSION, output_schema: OUTPUT_SCHEMA_VERSION }, mode, ctx.write)
  return 0
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
      process.exitCode = await runVersion(args, {
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

    case 'set-admin-password': {
      const isTty = process.stdout.isTTY ?? false
      const write = (s: string) => process.stdout.write(s)
      const writeErr = (s: string) => process.stderr.write(s)

      let flags: Record<string, string | boolean>
      let positionals: string[]
      let positionalIndexes: number[]
      let positionalContext: (string | undefined)[]
      try {
        ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(args, {
          booleans: ['json', 'human'],
        }))
      } catch (err) {
        if (!(err instanceof UsageError)) throw err
        process.exitCode = reportParseFailure(err, args, { writeErr, isTty })
        break
      }

      const mode = resolveMode(flags, isTty)

      const strayFlagsCode = checkStrayFlags(flags, new Set(['json', 'human']), mode, { writeErr })
      if (strayFlagsCode !== undefined) {
        process.exitCode = strayFlagsCode
        break
      }

      const USAGE = 'usage: lyraflow set-admin-password <email>  (password on stdin)'
      const [email] = positionals
      if (email === undefined) {
        process.exitCode = reportUsageError(new UsageError(USAGE), mode, { writeErr })
        break
      }
      // Anything past the email is unexpected -- same "one place this
      // message is built" primitive persons.ts uses, offset to the one
      // positional (email) this command already consumed.
      const positionalsCode = checkNoPositionals(
        {
          positionals: positionals.slice(1),
          positionalContext: positionalContext.slice(1),
          positionalIndexes: positionalIndexes.slice(1),
        },
        mode,
        { writeErr },
      )
      if (positionalsCode !== undefined) {
        process.exitCode = positionalsCode
        break
      }

      // Read from stdin, never from argv: an argument lands in shell
      // history and in `ps` output for every user on the box.
      let password: string
      try {
        password = await readAllStdin(process.stdin)
      } catch (err) {
        if (!(err instanceof StdinTimeoutError)) throw err
        // Rendered as `{error, code}` directly (not via `emitError`,
        // which fixes every non-ApiError/UsageError `code` to the single
        // literal `'error'`) so `--json` mode gives `stdin_timeout` a code
        // distinct from `empty_password` below -- the whole point of these
        // being two different exception classes rather than one.
        emitObject({ error: err.message, code: err.code }, mode, writeErr)
        process.exitCode = 1
        break
      }
      const { pg } = clients()
      try {
        const outcome = await setAdminPassword(pg, email, password)
        emitObject({ command: 'set-admin-password', email, outcome }, mode, write)
      } catch (err) {
        if (!(err instanceof EmptyPasswordError)) throw err
        emitObject({ error: err.message, code: err.code }, mode, writeErr)
        process.exitCode = 1
      } finally {
        await pg.end()
      }
      break
    }

    case 'seed-demo': {
      // Same shape as `set-admin-password` above: database handles, not an HTTP
      // client, because the ninety days of history this writes cannot be
      // created through the ingest API at all (see seed/rows.ts). The handles
      // are opened by the callback rather than here, so a usage error never
      // opens a connection it then has to close.
      process.exitCode = await runSeedDemo(
        args,
        {
          write: (s) => process.stdout.write(s),
          writeErr: (s) => process.stderr.write(s),
          isTty: process.stdout.isTTY ?? false,
          now: () => new Date(),
        },
        () => {
          const { pg, ch } = clients()
          return {
            pg,
            ch,
            database: env('LYRAFLOW_CLICKHOUSE_DB'),
            close: async () => {
              await pg.end()
              await ch.close()
            },
          }
        },
      )
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
    case 'funnels':
    case 'schema':
    case 'usage':
    case 'snippet': {
      const isTty = process.stdout.isTTY ?? false
      const stdinIsTty = process.stdin.isTTY ?? false

      // A holder, because the interrupt is deliberately not wired until
      // after the host/key check below (wiring it earlier would suppress
      // Node's default kill for a command that is about to fail anyway),
      // while these two writers are needed by that very check. Both are
      // closures called long afterwards, so reading it lazily is enough.
      const interruptRef: { current?: FollowInterrupt } = {}
      // Once an interrupt is under way it owns the output: the follow
      // loop's own cancelled-sleep catch would otherwise write a SECOND
      // next_cursor line (stderr is documented as one JSON object per line,
      // and a consumer taking "the" cursor would see two), and an in-flight
      // poll landing during the flush grace would emit records that are not
      // going to be waited for. Suppressing both here makes the
      // backlog and no-backlog paths behave identically — with no backlog
      // the process has already exited by this point, which is exactly why
      // the duplicate was invisible until a slow reader created a window.
      const suppressed = () => interruptRef.current?.interrupted() === true
      const write = (s: string) => {
        if (suppressed()) return
        process.stdout.write(s)
      }
      const writeErr = (s: string) => {
        if (suppressed()) return
        process.stderr.write(s)
      }

      // `||`, not `??`, throughout: an explicit but empty `--host=`/
      // `--server-key=` must fall back to the next tier too, not silently
      // win as `''` — a Client built with an empty host fails later with a
      // confusing URL error instead of this branch's clear "must be set"
      // message. `resolveHost` adds one more tier behind LYRAFLOW_HOST, for
      // `snippet` only — see its own docstring (issue #61).
      const host = resolveHost(command, args, process.env)
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
        //
        // `snippet` alone names LYRAFLOW_DOMAIN too: it is the one command
        // `resolveHost` gives a third source for (see its own docstring,
        // issue #61), so the message that told every other command's
        // operator exactly what to set would otherwise go quiet about the
        // one variable that could fix THIS command without touching either
        // of the other two. The other six commands genuinely have no such
        // fallback — naming it there would be a lie, worse than the
        // narrower message they already have, so this stays a one-command
        // exception rather than a change to the shared string.
        emitError(
          new UsageError(
            command === 'snippet'
              ? 'LYRAFLOW_HOST (or LYRAFLOW_DOMAIN) and LYRAFLOW_SERVER_KEY must be set (or pass --host/--server-key)'
              : 'LYRAFLOW_HOST and LYRAFLOW_SERVER_KEY must be set (or pass --host/--server-key)',
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
      // with no --follow. Passing an empty argv for the other five is how
      // that no-op is reached without a second code path to keep in step.
      const interrupt = wireFollowInterrupt(command === 'events' ? args : [])
      interruptRef.current = interrupt

      const ctx: CommandContext = {
        client: new Client({ host, serverKey }),
        // The exact value `Client` above was just built from — see
        // `CommandContext['host']`'s own docstring for why this is
        // threaded through separately rather than read back off `Client`
        // itself (its `#host` is private, deliberately).
        host,
        isTty,
        stdinIsTty,
        write,
        writeErr,
        now: () => new Date(),
        sleep: abortableSleep(interrupt.signal),
        onInterrupt: interrupt.onInterrupt,
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
        case 'funnels':
          process.exitCode = await runFunnels(args, ctx)
          break
        case 'schema':
          process.exitCode = await runSchema(args, ctx)
          break
        case 'usage':
          process.exitCode = await runUsage(args, ctx)
          break
        case 'snippet':
          process.exitCode = await runSnippet(args, ctx)
          break
      }
      break
    }

    default:
      console.error(
        'Usage: lyraflow <--version|migrate|create-project|set-admin-password|seed-demo|healthcheck|events|stats|persons|deletions|segments|funnels|schema|usage|snippet>',
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
 * Derives a default `--host`/`LYRAFLOW_HOST` value from `LYRAFLOW_DOMAIN` —
 * `resolveHost`'s third tier, `snippet` only (see that function's own
 * docstring for why only that one command gets it). An install that was
 * given a domain already knows its own public host: `LYRAFLOW_DOMAIN` is
 * exactly that value — install.sh writes it, docker-compose.yml passes it to
 * the proxy and, since #61, to the app container too — so requiring
 * `--host`/`LYRAFLOW_HOST` again just to print a snippet asks a question the
 * environment has already answered.
 *
 * Trims surrounding whitespace first. A bare host string passed directly as
 * `--host` has it stripped automatically — the WHATWG URL parser both
 * `Client` and `normalizeHost` (`packages/core/src/snippet/build.ts`) use
 * removes leading/trailing space from the input before parsing — so
 * trimming here keeps this derivation agreeing with that, rather than
 * embedding a space at the join between `https://` and a domain that has
 * leading whitespace and producing a string neither of them can parse.
 *
 * If the trimmed value already contains a scheme (`://`) — an operator's
 * `LYRAFLOW_DOMAIN` accidentally holding a full URL rather than a bare
 * domain — it is returned AS IS rather than having `https://` prepended a
 * second time. Blindly prepending would silently build
 * `https://https://example.com`, which a URL's `.origin` resolves to the
 * wrong-but-parseable `https://https` — a QUIET bad default, exactly the
 * failure mode #61 was filed to close, not a loud one. This also keeps this
 * default agreeing with typing the identical `LYRAFLOW_DOMAIN` value into
 * `--host` directly, whichever shape it is in — the two must never diverge.
 *
 * Otherwise prepends `https://` — never `http://`. This fallback only ever
 * fires for an install with a real public domain (`LYRAFLOW_DOMAIN` is set
 * only by the domain/TLS install path — see "Serving over HTTPS" in the main
 * README), so defaulting to `http://` here would reintroduce, as the
 * default, the exact mixed-content failure #61 describes.
 */
export function hostFromDomain(domain: string): string {
  const trimmed = domain.trim()
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`
}

/**
 * Resolves the host value this dispatch branch builds `Client`/`ctx.host`
 * from — the one place `--host`, `LYRAFLOW_HOST` and (for `snippet` alone)
 * `LYRAFLOW_DOMAIN` are ever read together. Each tier falls through to the
 * next only when ABSENT or an EMPTY STRING (`||`, not `??` — the same rule
 * the original `host || LYRAFLOW_HOST` used, so an explicit but empty
 * `--host=` still falls through instead of silently winning as `''`):
 *
 *   1. `--host` (argv, via `extractOverride`)
 *   2. `LYRAFLOW_HOST`
 *   3. `LYRAFLOW_DOMAIN`, `snippet` only, via `hostFromDomain`
 *
 * `LYRAFLOW_DOMAIN` is consulted for `snippet` alone, not the other seven
 * commands sharing this dispatch branch — this is what issue #61 asked for,
 * and the two are not equivalent risk. `snippet` prints a URL into markup a
 * browser parses, where a wrong scheme is the quiet mixed-content failure
 * the issue describes; the other six commands only need a host that
 * answers a request, a narrower default this issue was never filed to add.
 *
 * With none of the three set, returns `undefined` — every command,
 * `snippet` included, keeps today's behaviour and reaches this branch's
 * existing "LYRAFLOW_HOST and LYRAFLOW_SERVER_KEY must be set" usage error,
 * unchanged.
 */
export function resolveHost(
  command: string | undefined,
  args: string[],
  env: { LYRAFLOW_HOST?: string; LYRAFLOW_DOMAIN?: string },
): string | undefined {
  const fromDomain =
    command === 'snippet' && env.LYRAFLOW_DOMAIN ? hostFromDomain(env.LYRAFLOW_DOMAIN) : undefined
  return extractOverride(args, 'host') || env.LYRAFLOW_HOST || fromDomain
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
