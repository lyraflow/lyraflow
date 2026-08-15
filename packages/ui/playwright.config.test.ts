import { describe, expect, it } from 'vitest'
import config from './playwright.config.js'

/**
 * IMPORTANT 5 from the whole-branch review: with no `reporter` set,
 * Playwright's CI default is `dot` -- the `html` reporter (and the
 * `playwright-report/` directory `ci.yml`'s `upload-artifact` step targets
 * "on failure") is added by `create-playwright`'s scaffolding, not a
 * default of the test runner itself. Proved against a real failing run:
 * only `test-results/**\/trace.zip` came out, no `playwright-report/` at
 * all. This pins that the config actually requests the `html` reporter, so
 * a later edit that drops it again fails here rather than silently on the
 * first real red run.
 *
 * Lives at the package root, next to `playwright.config.ts` itself, NOT
 * under `src/`: this package's own `tsconfig.json` scopes both `rootDir`
 * and `include` to `src/**\/*` alone, and `playwright.config.ts` (which
 * uses `process.env`, a Node global this Vite-bundled package's tsconfig
 * deliberately carries no ambient types for -- see `build-output.test.ts`'s
 * own comment on the same restriction) has never been part of that
 * project. Importing it from a file UNDER `src/` pulls it into `tsc -b`'s
 * project graph and fails the build two ways at once: a `rootDir`
 * violation, and a missing `process` global. `vitest run` itself does not
 * care about `tsc`'s `include` -- it resolves and transforms this file
 * exactly as it does every other test in the package, root-level or not.
 */
describe('playwright.config', () => {
  it('configures the html reporter, so a failing run produces playwright-report/', () => {
    const reporters = config.reporter
    expect(Array.isArray(reporters)).toBe(true)
    const names = (reporters as Array<string | [string, unknown]>).map((r) =>
      Array.isArray(r) ? r[0] : r,
    )
    expect(names).toContain('html')
  })
})
