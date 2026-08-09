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

  it('has a live drain case for every listed method', () => {
    // `drainSnippetQueue`'s switch falls through to `default: break`, so a
    // listed method with no case is queued and then discarded -- worse than
    // not queueing it, because the caller sees no error either way.
    //
    // This only proves a `case '<method>':` label exists in code that runs
    // -- not that its body does the right thing. That narrower claim is as
    // far as a source-text check can honestly go: `drainSnippetQueue` calls
    // `track`, `page`, etc. as plain same-module function references, not
    // through an object a test could substitute or spy on, so there is no
    // way to drive it and observe per-method effects without changing that
    // dispatch shape. The `case` body's behaviour (does it call the right
    // function with the right args) is covered by index.test.ts's snippet-
    // queue replay tests instead. Comments are stripped first so a case
    // label that has been commented out -- dead code, exactly the failure
    // this test exists to catch -- cannot still satisfy a naive substring
    // search.
    const src = stripComments(readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8'))
    for (const method of SNIPPET_METHODS) {
      expect(src).toContain(`case '${method}':`)
    }
  })
})

/**
 * Removes line comments and block comments while leaving string and
 * template-literal contents untouched, so a `case` label that is only
 * reachable inside a comment stops being found by a plain substring search.
 * Not a full JS/TS parser -- it does not understand regex literals or
 * `${...}` interpolation nested inside a template literal -- but index.ts
 * contains neither, and the switch this scans is plain code.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '//') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        out += src[i]
        i++
      }
      if (i < src.length) {
        out += src[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}
