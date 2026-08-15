import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Guards against a whole CLASS of bug a unit test structurally cannot see:
 * a barrel import (`@lyraflow/core`'s root `index.ts`) pulling a
 * server-only module with a MODULE-SCOPE side effect (`auth/password.ts`'s
 * `promisify(scrypt)`) into the browser bundle. Rollup tree-shakes an
 * unused *export*, but can't prove a top-level call has no side effects, so
 * the call survives -- and with `node:crypto`/`node:util` externalized to
 * an empty stub object, that call throws a `TypeError` at module-evaluation
 * time, before React ever mounts. The result in a real browser: a blank
 * page, nothing rendered, one uncaught exception in the console.
 *
 * A grep for source-level identifiers CANNOT catch this -- confirmed
 * directly against the actual broken build: `hashPassword`, `scryptSync`,
 * `node:crypto` and `node:util` all appear ZERO times as literal strings in
 * the minified output, on both the broken bundle and the fixed one.
 * Minified names don't survive; the compiled call graph does. This test
 * instead evaluates the bundle itself, the same way a `<script
 * type="module">` tag does in a real page -- if a module-scope statement
 * throws before this package's own code ever runs, so does this test.
 *
 * `import.meta.glob` rather than `node:fs`/`node:path`: this package's
 * `tsconfig.json` deliberately carries no Node ambient types (it's
 * Vite-bundled, never run directly by Node -- see that file's own
 * `moduleResolution` comment), and Vite's own glob import is both the
 * idiomatic way to reach a build artifact from this package and enough on
 * its own to find and load the chunk.
 */
const bundleEntry = import.meta.glob('../dist/assets/index-*.js')

describe('production bundle', () => {
  // The entry chunk's own bootstrap does `createRoot(document.getElementById
  // ('root')).render(...)` and throws if that element is missing -- real
  // `index.html` always provides it. Without this, the test would fail on
  // that instead of on the bug it exists to catch.
  beforeAll(() => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
  })

  it('evaluates without throwing before the app ever renders', async () => {
    const paths = Object.keys(bundleEntry)
    if (paths.length === 0) {
      throw new Error(
        'packages/ui/dist/assets/index-*.js not found -- run "pnpm build" before ' +
          '"pnpm test" (the gate\'s own order: build, typecheck, lint, test).',
      )
    }
    // A dynamic import evaluates the chunk's top-level code for real, in
    // this test's own jsdom environment (`document`/`window` already
    // exist, same as vitest gives every other test in this package) --
    // exactly what a browser does on load. Any module-scope throw -- this
    // bug, or a future one shaped like it -- surfaces as a rejection here
    // instead of a silent white screen in production.
    const load = bundleEntry[paths[0] as string] as () => Promise<unknown>
    await expect(load()).resolves.toBeDefined()
  })

  // IMPORTANT 4 from the whole-branch review: `SnippetSection.tsx` used to
  // import `SNIPPET_METHODS` from `@lyraflow/sdk-browser`'s ROOT barrel,
  // which ends with a bare top-level `installGlobal()` call -- so loading
  // the admin bundle silently defined `window.lyraflow` on the admin
  // origin, which is also the ingest origin, and pulled the whole tracking
  // SDK along with it. Nothing about that throws, which is exactly why the
  // test above (the only one that existed) never caught it -- it can only
  // see a module-scope THROW. This test evaluates the SAME real bundle and
  // checks the one thing the other test structurally can't: that loading
  // the admin UI does not ALSO stand up a tracking SDK global on the same
  // window a real ingest response would otherwise use.
  it('does not define window.lyraflow -- the admin bundle must not carry the tracking SDK', async () => {
    const paths = Object.keys(bundleEntry)
    if (paths.length === 0) return // the earlier test already reports this case
    const load = bundleEntry[paths[0] as string] as () => Promise<unknown>
    await load()
    expect((window as unknown as { lyraflow?: unknown }).lyraflow).toBeUndefined()
  })
})
