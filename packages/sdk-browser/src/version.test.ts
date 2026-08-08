import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from './index.js'

/**
 * `VERSION` is a hand-written literal, and the server builds the immutable
 * `/lyraflow-<VERSION>.js` path out of it: `public, max-age=31536000,
 * immutable`. A browser that pinned that path and cached it will not ask
 * again for a year — not even a revalidation request.
 *
 * So the constant is not decoration. Ship a fix to the bundle without moving
 * it and every one of those browsers keeps running the broken bundle out of
 * its own cache, with nothing on the server able to reach them. Nothing tied
 * it to anything until this test.
 */
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

describe('VERSION', () => {
  it('matches the package manifest, which is what a release bumps', () => {
    expect(VERSION).toBe(manifest.version)
  })

  it('is a plain three-part version, since it goes into a URL path', () => {
    // `/lyraflow-<VERSION>.js` is registered as a literal route. Anything
    // needing escaping would produce a path no script tag could request and
    // no test would notice, because the route would simply 404 like any
    // other unknown version.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
