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
 *
 * Two things a first pass at this file left resting on a review's word
 * rather than the harness's own construction, closed here: the bundle read
 * off disk is resolved from the snippet's OWN parsed `src` (see
 * `resolveBundlePath`), not a path hardcoded independently of it, so a
 * mutation that repoints `src` is caught by what gets READ, not only by a
 * separate string assertion; and the fake transport records the URL and
 * write-key header of every request it receives (see `newPage`'s
 * `requests`), so a mutation that breaks authentication or reachability
 * (`writeKey`→`write_key`, `init({host})` diverging from `src`'s origin)
 * fails here too, not only in `snippet.test.ts`'s string-level suite.
 */
const SDK_BROWSER_DIST_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'sdk-browser',
  'dist',
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

/**
 * Resolves the LOCAL file this test reads from the `src` the snippet itself
 * printed, rather than a filename hardcoded independently of it — a fixed
 * `dist/lyraflow.js` constant would keep passing even if `buildSnippet`
 * repointed `src` at a different file, since nothing would connect the two.
 * Reading whatever `src`'s own path names means a mutation that changes
 * `src` without changing what actually gets read is caught by THIS
 * resolution, not only by the separate string assertion in the `points its
 * src at the printed host` test below.
 */
function resolveBundlePath(src: string): string {
  const filename = new URL(src).pathname.replace(/^\//, '')
  return join(SDK_BROWSER_DIST_DIR, filename)
}

const open: Window[] = []

afterEach(async () => {
  // The SDK's transport owns a 5s interval and two unload listeners; leaving
  // a window open leaks both into the rest of the run — same cleanup
  // sdk-browser's own snippet.test.ts uses.
  while (open.length > 0) await open.pop()?.happyDOM.close()
})

interface CapturedRequest {
  url: string
  writeKey: string | null
}

function newPage(): {
  run: (code: string) => void
  sent: string[]
  requests: CapturedRequest[]
  api: () => SnippetApi
} {
  const win = new Window({ url: 'https://shop.example.test/checkout' })
  open.push(win)

  // The fake transport. Installed before any SDK code runs, because
  // `Transport` binds `globalThis.fetch` in its constructor — which happens
  // during the `init` this page replays out of the stub queue.
  //
  // Records the URL and write-key HEADER of every request, not just the
  // body — an SDK that cannot authenticate (a mismatched write key) or
  // cannot reach the server (`init({host})` pointed somewhere other than
  // `src`'s own origin) still passes every assertion below that only reads
  // `sent`'s bodies, since this fake accepts and 202s anything unconditionally.
  // `requests` closes that: it is what proves the SDK actually dialled the
  // host and used the write key the snippet embedded, not merely that IT
  // BELIEVES it did.
  const sent: string[] = []
  const requests: CapturedRequest[] = []
  ;(win as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init: { body: string; headers?: Record<string, string> },
  ) => {
    sent.push(init.body)
    requests.push({ url, writeKey: init.headers?.['x-lyraflow-write-key'] ?? null })
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
  return { run, sent, requests, api }
}

/** Every event name the fake transport actually received, across all batches. */
function delivered(sent: string[]): string[] {
  return sent.flatMap((body) =>
    (JSON.parse(body) as { batch: { event?: string }[] }).batch.map((e) => e.event ?? ''),
  )
}

/** The built bundle — read from the LOCAL path `src` itself resolves to,
 * via `resolveBundlePath` — and the emitted snippet's two inline blocks, in
 * document order. `existsSync`'s message is the whole point of Step 2 of
 * this command's own task: deleting `dist/lyraflow.js` must fail HERE, by
 * name, not with a bare `ENOENT` from `readFileSync` three lines down. */
function snippetParts(
  src: string,
  inline: string[],
): { bundle: string; stub: string; initCall: string } {
  // Ahead of `resolveBundlePath`'s own `new URL(src)`, deliberately: an
  // empty `src` (the shape a deleted or mis-templated `<script async src=…>`
  // line produces — `parseSnippet` returns `''` when no such tag matched)
  // would otherwise reach `new URL('')` and fail with a bare, unhelpful
  // `TypeError: Invalid URL` — exactly the opaque-throw shape Step 2 of this
  // command's own task exists to rule out, just one layer up from the
  // missing-build case `existsSync` below already names.
  expect(
    src,
    'the emitted snippet has no <script src=…> — the bundle-loading tag is missing, so no bundle was ever going to be loaded',
  ).not.toBe('')
  const bundlePath = resolveBundlePath(src)
  expect(existsSync(bundlePath), `${bundlePath} is missing — run pnpm build first`).toBe(true)
  expect(inline.length, 'the emitted snippet should have two inline scripts').toBe(2)
  const [stub, initCall] = inline as [string, string]
  return { bundle: readFileSync(bundlePath, 'utf8'), stub, initCall }
}

/** The install snippet exactly as the main README publishes it — the block
 * `packages/sdk-browser/src/snippet.test.ts` already parses and drives, read
 * here from the same file by the same anchor so the two suites cannot drift
 * apart about what "the README's snippet" is. */
const README_PATH = join(import.meta.dirname, '..', '..', '..', '..', '..', 'README.md')
const README_HOST = 'https://analytics.example.com'
const README_WRITE_KEY = 'wk_live_…'

function readmeSnippet(): string {
  const readme = readFileSync(README_PATH, 'utf8')
  const block = /Paste this before `<\/head>`:\s*```html\n([\s\S]*?)```/.exec(readme)
  if (block === null) throw new Error('the README no longer contains the install snippet')
  return (block[1] as string).trimEnd()
}

describe('the snippet runSnippet emits, against the built bundle', () => {
  it('points its src at the printed host', async () => {
    const snippet = await emittedSnippet()
    expect(parseSnippet(snippet).src).toBe(`${HOST}/lyraflow.js`)
  })

  it('is byte-for-byte the block the main README documents, once the placeholders are filled in', async () => {
    // `packages/cli/README.md` promises this command emits "the exact block
    // documented under *Sending events from a browser* in the main README".
    // Two suites pinned the two copies — `sdk-browser/src/snippet.test.ts`
    // the README's, `snippet-bundle.test.ts` the CLI's — and NOTHING
    // compared them, so either could be edited into disagreement with the
    // documentation still claiming they are identical. This is the same
    // drift class Task 1 exists to prevent for `SNIPPET_METHODS`, closed the
    // same way: one source, compared, not two copies trusted.
    //
    // The only permitted difference is the two placeholder values the
    // command substitutes for real — substituted here, then compared
    // exactly. A whitespace change, a reordered attribute, an added
    // comment: all fail.
    const emitted = await emittedSnippet()
    const expected = readmeSnippet()
      .replaceAll(README_HOST, HOST)
      .replaceAll(README_WRITE_KEY, WRITE_KEY)
    expect(emitted).toBe(expected)
  })

  it('initialises the SDK and delivers events queued before the script loaded', async () => {
    const snippet = await emittedSnippet()
    const { inline, src } = parseSnippet(snippet)
    const { bundle, stub, initCall } = snippetParts(src, inline)
    const { run, sent, requests, api } = newPage()

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

    // Not just "an event arrived somewhere" — the SDK actually dialled the
    // host `init({host})` named (the same origin `src` was loaded from) and
    // authenticated with the write key `init({writeKey})` embedded. Renaming
    // `writeKey`→`write_key` in the template, or pointing `init`'s host at a
    // different origin than `src`, is an SDK that cannot reach or cannot
    // authenticate to the real server — this fails on either, where the
    // assertions above (which only inspect the fake's 202 response and the
    // batch body) would not.
    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      expect(req.url).toBe(`${HOST}/v1/batch`)
      expect(req.writeKey).toBe(WRITE_KEY)
    }
  })

  it('delivers the same events when a cached bundle runs before the init block', async () => {
    // The warm-cache ordering, and the ordinary repeat visit: an `async`
    // script runs the moment it is FETCHED, so a bundle already in cache can
    // execute before the inline block that calls `init` has been parsed.
    // The queue therefore reaches the bundle with no `init` in it. Plan 6's
    // fix round found this as a SECOND, separate defect from the cold-cache
    // one above — fixing one did not fix the other.
    const snippet = await emittedSnippet()
    const { inline, src } = parseSnippet(snippet)
    const { bundle, stub, initCall } = snippetParts(src, inline)
    const { run, sent, requests, api } = newPage()

    run(stub)
    run('window.lyraflow.track("early_signup", { plan: "trial" })')
    // The bundle, BEFORE the init block — the only difference from the test
    // above.
    run(bundle)
    run(initCall)

    api().track('after_load', { plan: 'pro' })
    await api().flush()

    expect(delivered(sent)).toEqual(['early_signup', 'after_load'])
    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      expect(req.url).toBe(`${HOST}/v1/batch`)
      expect(req.writeKey).toBe(WRITE_KEY)
    }
  })
})
