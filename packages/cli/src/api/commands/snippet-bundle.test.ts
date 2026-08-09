import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { Client } from '../client.js'
import type { CommandContext } from '../context.js'
import { runSnippet } from './snippet.js'

/**
 * The one test in this package that runs the snippet `runSnippet` ACTUALLY
 * EMITS — the string a real `lyraflow snippet` invocation prints — against
 * the SHIPPED `dist/lyraflow.js`, evaluated as a `<script>` in a DOM the
 * same way a browser would.
 *
 * Every other test of this command (`snippet.test.ts`) either asserts on
 * the emitted TEXT (does it contain the host, the write key, the right
 * script tags) or never touches a browser at all. None of them prove the
 * text, once pasted onto a page, actually starts the SDK — which is
 * precisely the gap that shipped a snippet through twelve reviews on the
 * plan before this one, because every test then either imported the module
 * directly or hand-built a fake `window.lyraflow.q` queue instead of
 * replaying the real stub.
 *
 * `packages/sdk-browser/src/snippet.test.ts` already does this for the
 * README's own copy of the snippet. This file is its sibling, not a
 * duplicate: the snippet under test here comes from `runSnippet`'s own
 * output, so a change to `buildSnippet` (snippet.ts) that breaks the
 * template — while leaving the README's hand-written copy untouched — fails
 * here and nowhere else.
 */
const BUNDLE_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'sdk-browser',
  'dist',
  'lyraflow.js',
)

const HOST = 'https://analytics.example.test'
const WRITE_KEY = 'wk_bundle_test_key'

interface SnippetApi {
  init?: (options: unknown) => void
  track: (event: string, properties?: Record<string, unknown>) => void
  flush: () => Promise<void>
}

/**
 * A fake `Client` answering only `GET /v1/project` for real — the one
 * request `runSnippet` needs to succeed to have anything to print at all.
 * `schema/events` and `events/stats` are informational (snippet.ts's own
 * module docstring) and irrelevant to whether the bundle initialises, so
 * both are answered with empty results rather than wired up for real; this
 * test's entire concern is the SNIPPET STRING, not the events table under
 * it.
 */
function fakeClient(): Client {
  return {
    get: async (path: string) => {
      if (path === '/v1/project') {
        return { name: 'Bundle Test', slug: 'bundle-test', write_key: WRITE_KEY }
      }
      if (path === '/v1/schema/events') return { events: [] }
      if (path === '/v1/events/stats') return { buckets: [] }
      throw new Error(`snippet-bundle.test.ts: unexpected request ${path}`)
    },
  } as unknown as Client
}

/** Runs `runSnippet(['--json'], ...)` against the fake client above and
 * returns the exact `snippet` field it emits — the same string a real
 * `lyraflow snippet --json` invocation would print for `.snippet`. */
async function emittedSnippet(): Promise<string> {
  const out: string[] = []
  const ctx: CommandContext = {
    client: fakeClient(),
    host: HOST,
    isTty: false,
    stdinIsTty: false,
    write: (s) => out.push(s),
    writeErr: () => {},
    now: () => new Date('2026-08-09T12:00:00.000Z'),
    sleep: () => Promise.resolve(),
    prompt: () => Promise.reject(new Error('runSnippet never prompts')),
  }
  const code = await runSnippet(['--json'], ctx)
  expect(code, 'runSnippet did not exit 0 while building the fixture for this test').toBe(0)
  const parsed = JSON.parse(out.join('')) as { snippet: string }
  return parsed.snippet
}

/**
 * The inline `<script>` bodies of a snippet, in document order, plus the
 * `src` of its one external script tag — the identical parse
 * `sdk-browser/src/snippet.test.ts`'s own `readSnippet` performs, applied to
 * a string already in hand instead of a block lifted out of a Markdown file.
 */
function parseSnippet(html: string): { inline: string[]; src: string } {
  const inline: string[] = []
  let src = ''
  const tag = /<script([^>]*)>([\s\S]*?)<\/script>/g
  let match = tag.exec(html)
  while (match !== null) {
    const attrs = match[1] as string
    const srcAttr = /src="([^"]+)"/.exec(attrs)
    if (srcAttr) src = srcAttr[1] as string
    else inline.push(match[2] as string)
    match = tag.exec(html)
  }
  return { inline, src }
}

const open: Window[] = []

afterEach(async () => {
  // The SDK's transport owns a 5s interval and two unload listeners; leaving
  // a window open leaks both into the rest of the run — same cleanup
  // sdk-browser's own snippet.test.ts uses.
  while (open.length > 0) await open.pop()?.happyDOM.close()
})

function newPage(): {
  run: (code: string) => void
  sent: string[]
  api: () => SnippetApi
} {
  const win = new Window({ url: 'https://shop.example.test/checkout' })
  open.push(win)

  // The fake transport. Installed before any SDK code runs, because
  // `Transport` binds `globalThis.fetch` in its constructor — which happens
  // during the `init` this page replays out of the stub queue.
  const sent: string[] = []
  ;(win as unknown as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    sent.push(init.body)
    const count = (JSON.parse(init.body) as { batch: unknown[] }).batch.length
    return {
      status: 202,
      headers: { get: () => null },
      json: async () => ({ accepted: count, rejected: 0, throttled: 0 }),
    }
  }

  const run = (code: string) => {
    const el = win.document.createElement('script')
    el.textContent = code
    win.document.head.appendChild(el)
  }
  const api = () => (win as unknown as { lyraflow: SnippetApi }).lyraflow
  return { run, sent, api }
}

/** Every event name the fake transport actually received, across all batches. */
function delivered(sent: string[]): string[] {
  return sent.flatMap((body) =>
    (JSON.parse(body) as { batch: { event?: string }[] }).batch.map((e) => e.event ?? ''),
  )
}

/** The built bundle and the emitted snippet's two inline blocks, in document
 * order. `existsSync`'s message is the whole point of Step 2 of this
 * command's own task: deleting `dist/lyraflow.js` must fail HERE, by name,
 * not with a bare `ENOENT` from `readFileSync` three lines down. */
function snippetParts(inline: string[]): { bundle: string; stub: string; initCall: string } {
  expect(existsSync(BUNDLE_PATH), 'dist/lyraflow.js is missing — run pnpm build first').toBe(true)
  expect(inline.length, 'the emitted snippet should have two inline scripts').toBe(2)
  const [stub, initCall] = inline as [string, string]
  return { bundle: readFileSync(BUNDLE_PATH, 'utf8'), stub, initCall }
}

describe('the snippet runSnippet emits, against the built bundle', () => {
  it('points its src at the printed host', async () => {
    const snippet = await emittedSnippet()
    expect(parseSnippet(snippet).src).toBe(`${HOST}/lyraflow.js`)
  })

  it('initialises the SDK and delivers events queued before the script loaded', async () => {
    const snippet = await emittedSnippet()
    const { inline } = parseSnippet(snippet)
    const { bundle, stub, initCall } = snippetParts(inline)
    const { run, sent, api } = newPage()

    // 1. The stub, exactly as `runSnippet` printed it.
    run(stub)
    expect(
      typeof api().init,
      'the stub does not forward init(), so the next block cannot call it',
    ).toBe('function')

    // 2. `<script async src=…>` has NOT loaded yet — that is what `async`
    //    means, and it is the state the page is in when the third block
    //    runs. Everything until step 4 therefore goes through the stub.
    run('window.lyraflow.track("early_signup", { plan: "trial" })')

    // 3. The init block, verbatim from `runSnippet`'s own output. This is
    //    the call that raised `lyraflow.init is not a function` on every
    //    page load, on the plan this command exists to not repeat.
    run(initCall)

    // 4. The async bundle arrives.
    run(bundle)

    // 5. And the page keeps tracking through the same global.
    api().track('after_load', { plan: 'pro' })
    await api().flush()

    // Both events, and the pre-load one first: the queued `init` has to be
    // replayed ahead of the `track` sitting in front of it in the queue, or
    // that track is dropped as "called before init()".
    expect(delivered(sent)).toEqual(['early_signup', 'after_load'])
    const first = (JSON.parse(sent[0] as string) as { batch: unknown[] }).batch[0]
    expect(first).toMatchObject({
      type: 'track',
      event: 'early_signup',
      properties: { plan: 'trial' },
      context: { url: 'https://shop.example.test/checkout' },
    })
  })

  it('delivers the same events when a cached bundle runs before the init block', async () => {
    // The warm-cache ordering, and the ordinary repeat visit: an `async`
    // script runs the moment it is FETCHED, so a bundle already in cache can
    // execute before the inline block that calls `init` has been parsed.
    // The queue therefore reaches the bundle with no `init` in it. Plan 6's
    // fix round found this as a SECOND, separate defect from the cold-cache
    // one above — fixing one did not fix the other.
    const snippet = await emittedSnippet()
    const { inline } = parseSnippet(snippet)
    const { bundle, stub, initCall } = snippetParts(inline)
    const { run, sent, api } = newPage()

    run(stub)
    run('window.lyraflow.track("early_signup", { plan: "trial" })')
    // The bundle, BEFORE the init block — the only difference from the test
    // above.
    run(bundle)
    run(initCall)

    api().track('after_load', { plan: 'pro' })
    await api().flush()

    expect(delivered(sent)).toEqual(['early_signup', 'after_load'])
  })
})
