import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * `package.json` gained an `exports` map in this change (IMPORTANT 4 from
 * the whole-branch review, for `./snippet-methods.js`'s own subpath). The
 * moment ANY `exports` map exists, it becomes a closed allowlist -- every
 * subpath not listed becomes unreachable, including the package's own
 * manifest. `packages/server/src/sdk/routes.ts`'s `loadBundle` resolves
 * exactly `@lyraflow/sdk-browser/package.json` (to locate `dist/lyraflow.js`
 * relative to it, without a hardcoded relative path across packages) --
 * this pins that resolution so it can't be silently dropped again.
 */
describe('@lyraflow/sdk-browser package.json exports', () => {
  it('resolves its own package.json through the exports map', () => {
    const require = createRequire(import.meta.url)
    expect(() => require.resolve('@lyraflow/sdk-browser/package.json')).not.toThrow()
  })

  it('resolves the snippet-methods subpath too', () => {
    const require = createRequire(import.meta.url)
    expect(() => require.resolve('@lyraflow/sdk-browser/snippet-methods.js')).not.toThrow()
  })
})
