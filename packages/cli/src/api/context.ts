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
  /** Whether the destination is a real terminal — `resolveMode`'s second
   * argument, threaded through here so a test can fake it without a real
   * TTY. */
  isTty: boolean
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
  /** Injected so `--follow` can be tested without real time passing; also
   * the hook a real dispatch would wire to cancellation (e.g. SIGINT). */
  sleep: (ms: number) => Promise<void>
}
