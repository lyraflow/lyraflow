import { hashPassword } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'

export class EmptyPasswordError extends Error {
  /** Distinct from `StdinTimeoutError`'s, so `--json` mode lets a caller
   * tell "typed nothing" apart from "we gave up waiting" without parsing
   * the message text. */
  readonly code = 'empty_password'

  constructor() {
    super(
      'Refusing to set an empty password. Pipe one in, e.g. `... | lyraflow set-admin-password you@example.com`.',
    )
    this.name = 'EmptyPasswordError'
  }
}

/**
 * Thrown by `readAllStdin` when `STDIN_READ_TIMEOUT_MS` elapses with no
 * password. Deliberately NOT the same failure as `EmptyPasswordError`: that
 * one means a real, empty answer arrived; this one means no answer arrived
 * at all, and conflating the two would tell an operator watching a stuck
 * terminal the wrong story about what happened.
 */
export class StdinTimeoutError extends Error {
  readonly code = 'stdin_timeout'

  constructor(timeoutMs: number) {
    super(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for a password on stdin. Pipe one in, e.g. \`... | lyraflow set-admin-password you@example.com\`, or type it and press Ctrl-D.`,
    )
    this.name = 'StdinTimeoutError'
  }
}

/**
 * How long `readAllStdin` waits for the password before giving up.
 *
 * Reading stdin as an async stream never resolves against an interactive
 * terminal nobody types into, and `input.isTTY` cannot be trusted to rule
 * that out on its own -- it is commonly TRUE under tmux, `script`, and most
 * agent runners (see `createPrompt`'s docstring in index.ts, which learned
 * this the hard way against a real pty). A command that hangs forever with
 * no output is indistinguishable from one that is working, so this bounds
 * it -- and `readAllStdin` writes a hint to stderr up front so a human
 * watching the terminal is not left guessing either.
 *
 * Two minutes, matching `PROMPT_TIMEOUT_MS` (index.ts): generous enough
 * that an operator typing a password by hand and finishing with Ctrl-D is
 * never cut off, short enough that an unattended invocation fails visibly
 * rather than occupying a terminal indefinitely.
 */
export const STDIN_READ_TIMEOUT_MS = 2 * 60_000

/**
 * Reads the whole of stdin as UTF-8, bounded by `timeoutMs`. Used only by
 * `set-admin-password`, which takes the password this way so it never
 * appears in shell history or in `ps` output the way an argv value would.
 *
 * A closed or immediately-ended stdin yields `''`, which `setAdminPassword`
 * refuses via `EmptyPasswordError` -- a real, empty answer. Stdin that
 * never produces anything at all -- no data, no close, no error, ever,
 * which is exactly what an allocated-but-untouched pty looks like -- times
 * out and rejects with `StdinTimeoutError` instead: a DIFFERENT failure,
 * on purpose, so the two are never confused with each other downstream.
 *
 * When `input` is a TTY, writes a one-line hint to `hint` (stderr by
 * default) BEFORE blocking on the read -- never to stdout, since a prompt
 * is not a record -- so a human staring at a silent terminal has an
 * immediate answer to "what is this waiting for" instead of a two-minute
 * mystery.
 *
 * `input`/`hint`/`timeoutMs` default to the real `process.stdin` /
 * `process.stderr` / `STDIN_READ_TIMEOUT_MS`, overridable so a test can
 * prove both the piped-input path and the timeout backstop against a fake
 * stream instead of the real process's stdin, and without a real two-minute
 * wait -- the same reasoning `createPrompt` (index.ts) already applies to
 * its own `input`/`output`/`timeoutMs` parameters.
 */
export function readAllStdin(
  input: NodeJS.ReadableStream = process.stdin,
  hint: (s: string) => void = (s) => process.stderr.write(s),
  timeoutMs: number = STDIN_READ_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if ((input as { isTTY?: boolean }).isTTY) {
      try {
        hint('Reading password from stdin. Type it and press Ctrl-D, or pipe it in.\n')
      } catch {
        // A failed hint write changes nothing about the read that follows;
        // see `finish`/`onError` below for the read's own failure handling.
      }
    }

    const chunks: Buffer[] = []
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('close', onClose)
      input.removeListener('error', onError)
      // Registering a 'data' listener switches a Readable into flowing
      // mode, and it STAYS there once switched -- removing the listener
      // above does not undo it. For a TTY specifically, flowing mode keeps
      // the underlying fd polling, which keeps the event loop alive: on the
      // timeout path, found live under a real pty, this was the difference
      // between "prints the timeout error" (it did) and "the process then
      // actually exits" (it did not -- the operator got the right message
      // and a shell that never returned). `pause()` is a no-op once the
      // stream has already ended, so this is safe on every path, not only
      // the timeout one.
      if (typeof (input as { pause?: () => void }).pause === 'function') {
        ;(input as { pause: () => void }).pause()
      }
    }

    const succeed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    // Both `end` (a clean close) and `close` (destroy() with no error,
    // which skips `end` entirely) resolve the same way -- the same
    // belt-and-braces pairing `createPrompt` uses for the identical reason,
    // documented in its own docstring.
    const onEnd = () => succeed()
    const onClose = () => succeed()
    const onError = (err: Error) => fail(err)

    input.on('data', onData)
    input.once('end', onEnd)
    input.once('close', onClose)
    input.once('error', onError)

    // The ending no stream event can ever announce: nothing happens, ever.
    // Only a bounded timeout can end this one -- see this function's own
    // docstring and `STDIN_READ_TIMEOUT_MS`'s for why.
    const timer = setTimeout(() => fail(new StdinTimeoutError(timeoutMs)), timeoutMs)
  })
}

/**
 * The only way to change the admin password, and the recovery path for an
 * install that upgraded into the admin account without one in its `.env`.
 *
 * There is at most one admin row (`admin_user` is a singleton by product
 * decision, not by constraint), so this replaces whichever row is there
 * rather than matching on email -- an operator who has forgotten the
 * password has usually also forgotten which address it was under, and
 * matching on email would answer that with a silent no-op.
 */
export async function setAdminPassword(
  pg: Pool,
  email: string,
  password: string,
): Promise<'created' | 'updated'> {
  const trimmed = password.trim()
  if (trimmed.length === 0) throw new EmptyPasswordError()
  const hash = await hashPassword(trimmed)

  const existing = await pg.query<{ id: string }>('SELECT id FROM admin_user LIMIT 1')
  const row = existing.rows[0]
  if (!row) {
    await pg.query('INSERT INTO admin_user (email, password_hash) VALUES ($1, $2)', [email, hash])
    return 'created'
  }

  await pg.query('UPDATE admin_user SET email = $2, password_hash = $3 WHERE id = $1', [
    Number(row.id),
    email,
    hash,
  ])
  // Every live session was issued against the credential this call just
  // replaced. See the test for why leaving them alive defeats the point of
  // the command.
  await pg.query('DELETE FROM sessions WHERE admin_user_id = $1', [Number(row.id)])
  return 'updated'
}
