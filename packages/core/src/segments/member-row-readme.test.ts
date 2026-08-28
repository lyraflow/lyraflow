import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memberProjection } from './compile.js'

/**
 * The README's worked member-row JSON, checked against the columns the query
 * actually selects.
 *
 * This test class already exists in the repo -- `test/compose-flags.test.ts`
 * derives the Compose version floor and compares it to the README,
 * `packages/sdk-browser/src/snippet.test.ts` runs the README's own install
 * snippet against the built bundle -- and nothing on the person-profile
 * branch crossed from what the code does to what the repo says it does. This
 * is the cheapest crossing available: the three routes that return member
 * rows all project `memberProjection()`, and the README documents that row
 * twice, in JSON a machine can read.
 *
 * It caught a real one. `identified` was added to the projection and to all
 * three routes, and neither worked example grew the field -- so an SDK author
 * reading either one wrote a type that dropped it, with every test green.
 *
 * The assertion is set equality, not a substring search: a field the query
 * returns and the README omits fails, AND a field the README shows that the
 * query does not return fails too. Documenting a field that does not exist is
 * the worse of the two errors and the one no reviewer notices.
 *
 * Deliberately NOT asserted here: anything about the prose around the JSON.
 * A capability claim in prose ("there is no way to X") has no expressible
 * counterpart in the code, and pinning one with a string match would fail on
 * every rewording and catch nothing.
 */
const README_PATH = join(import.meta.dirname, '..', '..', '..', '..', 'README.md')

/**
 * The column names `memberProjection()` selects, in the order it selects
 * them.
 *
 * One column per line by construction (`memberProjection` joins with
 * `,\n  `), so this splits on newlines rather than on commas -- the trait
 * maps' `CAST((…), 'Map(String, String)')` expressions contain commas of
 * their own, and splitting on those would shred them into fragments that
 * happen to look like column names.
 */
function projectedColumns(): string[] {
  return memberProjection()
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line !== '')
    .map((line) => {
      // `<expr> AS <alias>` for the derived columns, a bare column name for
      // `person_id`/`first_seen`/`last_seen`/`identified`. The LAST ` AS `
      // wins: a nested expression may contain one of its own.
      const at = line.lastIndexOf(' AS ')
      return at === -1 ? line : line.slice(at + 4)
    })
}

/**
 * The first member row of the first ```json block after `anchor`.
 *
 * `anchor` is matched literally rather than by a regular expression so that a
 * failure names the missing heading verbatim, which is the thing to go and
 * look for.
 */
function documentedRow(anchor: string): Record<string, unknown> {
  const readme = readFileSync(README_PATH, 'utf8')
  const at = readme.indexOf(anchor)
  if (at === -1) {
    throw new Error(
      `README no longer contains ${JSON.stringify(anchor)} -- this test locates the documented member row by it, so re-anchor it rather than deleting this test`,
    )
  }
  const block = /```json\n([\s\S]*?)```/.exec(readme.slice(at))
  if (block === null)
    throw new Error(`no JSON block follows ${JSON.stringify(anchor)} in the README`)
  const parsed = JSON.parse(block[1] as string) as { members?: Record<string, unknown>[] }
  const row = parsed.members?.[0]
  if (row === undefined)
    throw new Error(`the JSON block after ${JSON.stringify(anchor)} has no members[0]`)
  return row
}

describe('the README member row, against memberProjection', () => {
  // POST /v1/segments/preview and POST /v1/segments/:id/preview both answer
  // with exactly this projection (compileSegment's members branch).
  it('documents every column the segments member walk returns, and no others', () => {
    const row = documentedRow('### Retrieving members, not just the count')
    expect(Object.keys(row).sort()).toEqual(projectedColumns().sort())
  })

  // POST /v1/funnels/:id/people joins `base` by name and projects the SAME
  // `memberProjection()` (funnels/compile.ts's members branch), plus its own
  // `entered_at`, which only a funnel's per-person pass produces.
  it('documents the funnel people row as the same columns plus entered_at', () => {
    // Anchored on the section heading, not on `entered_at` itself: that
    // string sits INSIDE the block, so searching forward from it would skip
    // past the very block it identifies and check the next one.
    const row = documentedRow('### Who reached a step, or stopped there')
    expect(Object.keys(row).sort()).toEqual([...projectedColumns(), 'entered_at'].sort())
  })
})
