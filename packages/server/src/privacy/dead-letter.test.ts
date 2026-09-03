import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dead-letter match predicate exists in exactly ONE place: dead-letter.ts.
 * purge.ts and export.ts both interpolate the exported constant rather than
 * re-typing the `position(payload, …)` expression — a second copy would be a
 * second place for the purge and the export to silently disagree about which
 * rejected payloads belong to a person.
 */
describe('the dead-letter predicate lives in exactly one place', () => {
  it('is absent, as a literal, from purge.ts', () => {
    const source = readFileSync(join(import.meta.dirname, 'purge.ts'), 'utf8')
    expect(source).not.toContain('position(payload')
  })

  it('is absent, as a literal, from export.ts', () => {
    const source = readFileSync(join(import.meta.dirname, 'export.ts'), 'utf8')
    expect(source).not.toContain('position(payload')
  })
})
