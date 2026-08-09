/**
 * `CommandContext` — what a command handler needs from the outside world.
 *
 * Lives in its own leaf module, not in index.ts, on purpose: index.ts also
 * runs `main()` on import (guarded by the entry-point check at the bottom
 * of that file), so a command module that imported `CommandContext` FROM
 * index.ts would be one non-type import away from a real runtime cycle —
 * today it happens to stay type-only and get erased by
 * `verbatimModuleSyntax`, but nothing enforces that staying true as more
 * commands (Task 8 onward) are added. Keeping the interface here removes
 * the risk structurally instead of relying on every future import staying
 * type-only by discipline. index.ts re-exports this type so existing call
 * sites (`import type { CommandContext } from './index.js'`) keep working
 * unchanged.
 */

import type { Client } from './client.js'

export interface CommandContext {
  /** The configured API client — `events`/`stats` compose on this rather
   * than calling `fetch` themselves. Unused by `runVersion`, which talks
   * to nothing over the network. */
  client: Client
  /** Whether STDOUT is a real terminal — `resolveMode`'s second argument,
   * threaded through here so a test can fake it without a real TTY. This is
   * an OUTPUT-rendering signal only (human table vs. JSON); it answers "does
   * a human appear to be reading this", never "can anyone answer a
   * prompt" — see `stdinIsTty` for that question, and its own docstring for
   * why the two must not be conflated. Real dispatch populates this from
   * `process.stdout.isTTY`. */
  isTty: boolean
  /**
   * Whether STDIN is a real terminal — the question `persons delete`'s
   * `--yes` requirement actually needs answered: "is there an input a
   * human could type into," never "does the output look nice." Kept
   * separate from `isTty` on purpose: a pty-allocated agent harness (tmux,
   * `script`, most agent runners) commonly reports BOTH stdout and stdin as
   * TTYs, so this alone does not make an unattended prompt safe — see
   * `prompt`'s own docstring for the bounded-timeout backstop that closes
   * that gap. What this DOES fix on its own: a caller whose stdout happens
   * to be a pty (logged through `script`, say) but whose stdin is a closed
   * pipe or `/dev/null` — keying the `--yes` requirement on `isTty`
   * (stdout) there would wrongly skip it and then have nothing to prompt.
   * Real dispatch populates this from `process.stdin.isTTY`.
   */
  stdinIsTty: boolean
  /** Where normal output goes. Never `console.log`/`console.error` directly
   * from a command handler — writing through this is what lets a test
   * capture output without touching real stdout. */
  write: (s: string) => void
  /** Where error output goes — kept separate from `write` so an error line
   * never lands mixed into a stream of otherwise-valid NDJSON records. */
  writeErr: (s: string) => void
  /** The current time, as the command should see it. Injected so a test can
   * fix "now" rather than racing the real clock — `--since`'s relative
   * defaults (e.g. "the last 15 minutes") are resolved against this. */
  now: () => Date
  /** Injected so `--follow` can be tested without real time passing. NOT
   * the cancellation hook — see `onInterrupt`, and the note there on why a
   * cancellable sleep alone could not carry that job. */
  sleep: (ms: number) => Promise<void>
  /**
   * Registers a handler to run when the process is being interrupted
   * (SIGINT/SIGTERM), immediately before it exits — `events --follow`'s
   * only way to write its resume cursor on a `Ctrl-C` or a `docker stop`.
   *
   * THE HANDLER RUNS SYNCHRONOUSLY, THE INSTANT THE SIGNAL ARRIVES, and
   * whatever it passes to `writeErrNow` is HELD and written as the process
   * exits — which may be immediately, or after stdout's own backlog has
   * finished flushing (see `wireFollowInterrupt`). It may not await
   * anything, and nothing it schedules will run.
   *
   * Snapshot-then-write, rather than write-at-exit, for two reasons that
   * are both correctness rather than style. The loop keeps running during
   * that flush window, so reading its state at exit time could report a
   * cursor that has since advanced PAST records this process is about to
   * stop waiting to deliver; and everything a handler emits is written in a
   * SINGLE `writeSync` together with any warning that qualifies it, because
   * separate writes to a congested pipe have independent fates and the
   * shorter, more dangerous line is the one that wins. That is the whole
   * point. The previous
   * design cancelled `sleep` instead and let the follow loop unwind through
   * its own catch — which works only when the signal lands during the sleep
   * between polls. A `--follow` session spends the rest of its life inside
   * an HTTP request, and there the abort was OBSERVED BY NOTHING: the loop
   * was awaiting `client.get`, so the signal was consumed by the listener
   * (installing one suppresses Node's default kill) and discarded, leaving
   * the process alive for up to undici's 301-second `headersTimeout`. One
   * `Ctrl-C` did nothing; one `SIGTERM` did nothing, and systemd/`docker
   * stop` then SIGKILLed the process past its grace period — losing the
   * resume cursor that was the entire point.
   *
   * `writeErrNow` collects into that single synchronous write rather than
   * being `writeErr`: on POSIX `process.stderr` is asynchronous when it is
   * a pipe, and a queued write is simply dropped when the process exits
   * underneath it — which is exactly how this CLI is run by an agent
   * harness. `ctx.writeErr` also stops working the moment a signal arrives,
   * deliberately, so a command cannot emit a second, competing copy of what
   * its handler has already reported.
   *
   * Optional: a caller that cannot be interrupted (a test, `--version`'s
   * placeholder context) supplies nothing, and a command that registers a
   * handler must tolerate it never being called.
   */
  onInterrupt?: (handler: (writeErrNow: (s: string) => void) => void) => void
  /**
   * Asks a yes/no confirmation question and resolves the answer — `persons
   * delete`'s only route to a "are you sure" prompt, injected so the
   * confirmation is testable without a real terminal attached to the test
   * runner. `question` is always a fixed, hand-picked string chosen by the
   * calling command — never built from an argv token, a flag value, or an
   * id the user typed, the same rule `command-support.ts`'s usage messages
   * follow, and for the same reason: a positional argument reaching this
   * far could be a secret typed into the wrong slot, and a prompt shown at
   * a real terminal is not private storage either (screen readers, shared
   * screens, terminal scrollback).
   *
   * A real dispatch's implementation must resolve `false` — never hang —
   * no matter HOW the input stream stops producing an answer: a clean
   * `end()` (stdin piped from `/dev/null`, or Ctrl+D at a terminal), a
   * `destroy()` with no `'end'` at all, a `destroy(err)` (an `'error'`
   * event that must not go unhandled either), AND — the shape a `stdinIsTty:
   * true` check cannot rule out, since a pty-allocated harness typically
   * reports stdin as a real TTY too — an input that simply never produces
   * anything at all. "Is anyone there" is not something this stream alone
   * can ever decide, so a real implementation also needs a bounded timeout
   * that resolves `false` as the backstop of last resort. See index.ts's
   * `createPrompt` for how all of these are closed.
   */
  prompt: (question: string) => Promise<boolean>
}
