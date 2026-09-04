import { FUNNEL_DEFINITION_VERSION } from '@lyraflow/core'
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

  it('the segment modules the UI imports pull in nothing node-only', async () => {
    // These two are imported by the tree editor and run in the browser.
    // `validate.ts` imports only a type; `ast.ts` imports only zod. If either
    // ever gains a node builtin, the admin UI breaks at runtime rather than at
    // build time -- the same failure that once shipped a white screen with a
    // fully green suite.
    const ast = await import('@lyraflow/core/segments/ast.js')
    const validate = await import('@lyraflow/core/segments/validate.js')
    expect(ast.COMPARISON_OPERATORS).toContain('between')
    expect(validate.MAX_TREE_DEPTH).toBe(10)
    expect(typeof validate.costWarnings).toBe('function')
  })

  it('the funnel step module the UI types against pulls in nothing node-only', async () => {
    // `api/types.ts` re-exports `FunnelStep` from here, and
    // `WherePredicates` reads `MAX_WHERE_PREDICATES` from the segments AST
    // this module shares. The type re-export is erased, so it cannot break
    // the bundle on its own -- but the next thing to reach for a value from
    // this subpath would, and by then the failure is a white screen rather
    // than a red test. Same guard as the two above, one module earlier.
    const ast = await import('@lyraflow/core/funnels/ast.js')
    expect(ast.FUNNEL_DEFINITION_VERSION).toBe(FUNNEL_DEFINITION_VERSION)
    expect(typeof ast.FunnelStep.parse).toBe('function')
  })

  // The stored theme and palette are applied in App.tsx's first effect,
  // which runs AFTER the first paint -- so a dark or re-accented choice
  // flashed the default for one frame on every load. index.html carries an
  // inline script that sets both attributes before the bundle is even
  // requested. Vite passes a classic inline script through untouched, but
  // nothing else would notice if a config change or a template rewrite
  // dropped it: the app still works, one frame later. This reads the BUILT
  // index.html, not the source, for the same reason the tests above evaluate
  // the built bundle.
  it('the built index.html applies the stored theme and palette before first paint', async () => {
    const pages = import.meta.glob('../dist/index.html', { query: '?raw', import: 'default' })
    const paths = Object.keys(pages)
    if (paths.length === 0) {
      throw new Error(
        'packages/ui/dist/index.html not found -- run "pnpm build" before "pnpm test".',
      )
    }
    const html = (await (pages[paths[0] as string] as () => Promise<string>)()) as string
    const inline = html.indexOf('<script>')
    expect(inline).toBeGreaterThan(-1)
    // In <head>: a classic script there runs before the body is parsed,
    // which is before anything is painted. Vite hoists its own module tag
    // into <head> too, and module scripts are deferred, so where the two
    // sit relative to each other does not matter -- only that this one is
    // not in <body>.
    expect(inline).toBeLessThan(html.indexOf('</head>'))
    const body = html.slice(inline, html.indexOf('</script>', inline))
    // Quote-agnostic: the assertions name the keys and attributes, not the
    // exact source text, so a minifier changing quote style cannot fail them.
    expect(body).toContain('lf-theme')
    expect(body).toContain('lf-palette')
    expect(body).toContain('data-theme')
    expect(body).toContain('data-palette')
    expect(body).toContain('setAttribute')
    expect(body).toContain('try')
  })
})
