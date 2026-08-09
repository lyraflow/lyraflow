import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'
import { SNIPPET_METHODS } from './index.js'

describe('SNIPPET_METHODS', () => {
  it('lists every public method a page can call, and nothing else', () => {
    // The stub queues exactly these names. A public method missing from the
    // list is silently dropped when called before the bundle loads -- the
    // shape of Plan 6's defect, where `init` was missing and the documented
    // snippet could never initialise anything.
    const exportedFunctions = Object.entries(sdk)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
      .sort()
    expect([...SNIPPET_METHODS].sort()).toEqual(exportedFunctions)
  })

  it('has a drain case for every listed method', () => {
    // `drainSnippetQueue`'s switch falls through to `default: break`, so a
    // listed method with no case is queued and then discarded -- worse than
    // not queueing it, because the caller sees no error either way.
    const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
    for (const method of SNIPPET_METHODS) {
      expect(src).toContain(`case '${method}':`)
    }
  })
})
