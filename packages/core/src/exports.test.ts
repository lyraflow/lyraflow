import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * Small fix from the whole-branch review: `package.json`'s own `exports`
 * map lists `.` and `./snippet/build.js`, but not `./package.json` itself.
 * Node's `exports` map is a CLOSED allowlist the moment it exists at all --
 * once ANY subpath is listed, every subpath not listed becomes
 * unreachable, including the package's own manifest, which was previously
 * resolvable simply because no `exports` map existed to restrict it.
 * Nothing in this repo imports `@lyraflow/core/package.json` today, but
 * `@lyraflow/sdk-browser`'s `packages/server/src/sdk/routes.ts` resolves
 * exactly that subpath on ITS sibling package for a real reason (finding
 * its `dist/lyraflow.js` without a hardcoded relative path) -- the same
 * shape trips here the moment anything does the same for `core`. This pins
 * the resolution so a later `exports` edit can't silently drop it again.
 */
describe('@lyraflow/core package.json exports', () => {
  it('resolves its own package.json through the exports map', () => {
    const require = createRequire(import.meta.url)
    expect(() => require.resolve('@lyraflow/core/package.json')).not.toThrow()
  })
})
