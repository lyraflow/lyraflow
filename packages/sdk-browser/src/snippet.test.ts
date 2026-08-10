import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The one test that runs the SHIPPED artefacts the way a browser does: the
 * built `dist/lyraflow.js`, evaluated as a `<script>` in a DOM, driven by the
 * snippet lifted out of the public README rather than by anything written
 * here.
 *
 * Every other test in this package either hand-builds a fake
 * `window.lyraflow.q` and calls the imported module's `init()` directly, or
 * does `import * as lyraflow`. Both skip the two things that actually decide
 * whether a customer's page tracks anything at all: whether the stub forwards
 * `init` (it is the README, not this package, that decides that), and whether
 * the bundle ever takes over `window.lyraflow`, so that a queued `init` has
 * anything to run it. A whole-branch review found both broken with the whole
 * suite green.
 *
 * The snippet is PARSED OUT OF THE README, not copied here. A copy is a
 * second source of truth that can agree with itself while the documented one
 * is broken — precisely the failure this file exists to catch.
 */
const README_PATH = join(import.meta.dirname, '..', '..', '..', 'README.md')
const BUNDLE_PATH = join(import.meta.dirname, '..', 'dist', 'lyraflow.js')

const HOST = 'https://analytics.example.com'

interface SnippetApi {
  init?: (options: unknown) => void
  track: (event: string, properties?: Record<string, unknown>) => void
  flush: () => Promise<void>
}

/**
 * The inline `<script>` bodies of the README's install snippet, in document
 * order, plus the `src` of its one external script tag.
 */
function readSnippet(): { inline: string[]; src: string } {
  const readme = readFileSync(README_PATH, 'utf8')
  const block = /Paste this before `<\/head>`:\s*```html\n([\s\S]*?)```/.exec(readme)
  if (block === null) throw new Error('the README no longer contains the install snippet')
  const html = block[1] as string

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
  // a window open leaks both into the rest of the run.
  while (open.length > 0) await open.pop()?.happyDOM.close()
})

/** What the fake `fetch` hands back — Response-shaped only as far as the SDK reads it. */
interface FakeResponse {
  status: number
  headers: { get: () => null }
  json: () => Promise<unknown>
}

/** The ordinary answer: everything in the batch stored. */
const allAccepted = (count: number): FakeResponse => ({
  status: 202,
  headers: { get: () => null },
  json: async () => ({ accepted: count, rejected: 0, throttled: 0, over_quota: 0 }),
})

function newPage(respond: (count: number) => FakeResponse = allAccepted): {
  run: (code: string) => void
  sent: string[]
  api: () => SnippetApi
  warnings: string[]
  queued: () => unknown[]
} {
  const win = new Window({ url: 'https://shop.example.com/checkout' })
  open.push(win)

  // The fake transport. Installed before any SDK code runs, because
  // `Transport` binds `globalThis.fetch` in its constructor — which happens
  // during the `init` this page replays out of the stub queue.
  const sent: string[] = []
  ;(win as unknown as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    sent.push(init.body)
    return respond((JSON.parse(init.body) as { batch: unknown[] }).batch.length)
  }

  // The SDK's own `warn` writes to `console.warn` and nowhere else, so this is
  // the only place a developer's feedback about a refused batch can be
  // observed from outside the bundle — which is exactly the claim under test.
  const warnings: string[] = []
  win.console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))

  const run = (code: string) => {
    const el = win.document.createElement('script')
    el.textContent = code
    win.document.head.appendChild(el)
  }
  const api = () => (win as unknown as { lyraflow: SnippetApi }).lyraflow
  // Read through the storage key, not through an imported EventQueue: the
  // point of this file is that nothing here shares code with the bundle.
  const queued = (): unknown[] => {
    const raw = win.localStorage.getItem('lyraflow_queue')
    return raw === null ? [] : (JSON.parse(raw) as unknown[])
  }
  return { run, sent, api, warnings, queued }
}

/** Loads the bundle into a fresh page, initialised exactly as the README says. */
function bootedPage(respond?: (count: number) => FakeResponse) {
  const { bundle, stub, initCall } = snippetParts()
  const page = newPage(respond)
  page.run(stub)
  page.run(initCall)
  page.run(bundle)
  return page
}

/** The built bundle and the README's two inline blocks, in document order. */
function snippetParts(): { bundle: string; stub: string; initCall: string } {
  expect(existsSync(BUNDLE_PATH), 'dist/lyraflow.js is missing — run pnpm build first').toBe(true)
  const { inline } = readSnippet()
  expect(inline.length, 'the snippet should have two inline scripts').toBe(2)
  const [stub, initCall] = inline as [string, string]
  return { bundle: readFileSync(BUNDLE_PATH, 'utf8'), stub, initCall }
}

/** Every event name the fake transport actually received, across all batches. */
function delivered(sent: string[]): string[] {
  return sent.flatMap((body) =>
    (JSON.parse(body) as { batch: { event?: string }[] }).batch.map((e) => e.event ?? ''),
  )
}

describe('the README snippet, against the built bundle', () => {
  it('loads the bundle from the documented path', () => {
    expect(readSnippet().src).toBe(`${HOST}/lyraflow.js`)
  })

  it('initialises the SDK and delivers events queued before the script loaded', async () => {
    const { bundle, stub, initCall } = snippetParts()
    const { run, sent, api } = newPage()

    // 1. The stub, exactly as documented.
    run(stub)
    expect(
      typeof api().init,
      'the stub does not forward init(), so the next block cannot call it',
    ).toBe('function')

    // 2. `<script async src=…>` has NOT loaded yet — that is what `async`
    //    means, and it is the state the page is in when the third block runs.
    //    Everything until step 4 therefore goes through the stub.
    run('window.lyraflow.track("early_signup", { plan: "trial" })')

    // 3. The init block, verbatim from the README. This is the call that
    //    raised `lyraflow.init is not a function` on every page load.
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
      context: { url: 'https://shop.example.com/checkout' },
    })
  })

  it('delivers the same events when a cached bundle runs before the init block', async () => {
    // The warm-cache ordering, and the ordinary repeat visit: an `async`
    // script runs the moment it is FETCHED, so a bundle already in cache can
    // execute before the inline block that calls `init` has been parsed. The
    // queue therefore reaches the bundle with no `init` in it.
    //
    // Replaying it there fed every call to an SDK with no state — dropped one
    // by one as "called before init()" — and then discarded the queue with
    // the stub, so `init()`'s own drain found nothing either. The README's
    // promise that "a track() fired the instant the page renders is never
    // lost" was false on exactly the visit where the page renders fastest.
    const { bundle, stub, initCall } = snippetParts()
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

/**
 * Quota refusals, driven through the built bundle rather than the module.
 *
 * transport.test.ts covers both paths against `Transport` directly, which is
 * the right place for the branch matrix — but it is not what ships. A
 * refusal handled correctly in `transport.ts` and lost somewhere between
 * there and `dist/lyraflow.js` (a dead-code elimination that drops a warn, a
 * `console` the bundle never reaches, a queue write that outlives the drop)
 * looks identical to a working one from inside the module suite. Plan 6
 * shipped a snippet that could not initialise the SDK at all through twelve
 * reviews for exactly this reason.
 *
 * The `202` + `over_quota` case comes first because it is the one the server
 * actually produces: `/v1/batch` never answers `429`.
 */
describe('a quota refusal, against the built bundle', () => {
  it('reports an over-quota 202 to the console and does not keep the events queued', async () => {
    // The batch that CROSSES the quota, not one long past it: the ingest
    // checks per item, so this response stores the first event and refuses
    // the second — `accepted` and `over_quota` both non-zero. It is the first
    // response a project ever sees on running out, and a guard that only
    // looked at `over_quota` when nothing was accepted would say nothing
    // about it. (transport.test.ts pins the same shape at the module level;
    // this is the one that proves it survives into the shipped bundle.)
    const { sent, api, warnings, queued } = bootedPage((count) => ({
      status: 202,
      headers: { get: () => null },
      json: async () => ({
        accepted: 1,
        rejected: 0,
        throttled: 0,
        over_quota: count - 1,
      }),
    }))

    api().track('checkout_completed')
    api().track('checkout_completed_again')
    expect(queued()).toHaveLength(2)
    await api().flush()

    expect(sent).toHaveLength(1)
    // The developer is TOLD. Reading only `rejected` left this silent: a 202
    // whose body says nothing was stored is indistinguishable from a
    // successful delivery from the page's point of view.
    expect(warnings.join(' ')).toMatch(/quota/i)
    // And the queue drains rather than growing for the life of the tab.
    expect(queued()).toEqual([])
  })

  it('drops a 429 from something in front of the ingest instead of retrying it forever', async () => {
    // No `retry-after`, matching what the ingest's single-event routes send.
    const { api, sent, warnings, queued } = bootedPage(() => ({
      status: 429,
      headers: { get: () => null },
      json: async () => ({ error: 'quota_exceeded' }),
    }))

    api().track('checkout_completed')
    await api().flush()

    expect(sent).toHaveLength(1)
    expect(warnings.join(' ')).toMatch(/quota/i)
    expect(queued()).toEqual([])

    // No backoff was armed: the very next flush reaches the network. A 429
    // that fell through to the transport's retry path would instead sit out
    // an exponential backoff here, having kept the batch — the queue never
    // draining, every instrumented browser retrying for the rest of the
    // month.
    api().track('second_event')
    await api().flush()
    expect(sent).toHaveLength(2)
    expect(queued()).toEqual([])
  })
})
