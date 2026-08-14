import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from './output.js'

/**
 * `CLI_VERSION` is a hand-written literal and `lyraflow --version` is what an
 * operator or an agent reads to find out what it is talking to. Nothing tied
 * it to the package manifest until this test, and the two had already drifted
 * once: cutting 0.2.0 moved every `package.json` while this constant still
 * said `0.1.0`, so the CLI would have reported a version that no longer
 * existed anywhere else in the repo.
 *
 * That failure is silent by construction — a wrong version string breaks no
 * behaviour, passes every other test, and is only discovered by somebody
 * trying to reproduce a bug against the wrong source.
 *
 * `packages/sdk-browser/src/version.test.ts` pins its own `VERSION` the same
 * way and for a sharper reason (the immutable bundle URL is built from it).
 * This is the same guard for the other hand-written version in the repo.
 */
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as { version: string }

describe('CLI_VERSION', () => {
  it('matches the package manifest, which is what a release bumps', () => {
    expect(CLI_VERSION).toBe(manifest.version)
  })

  it('is a plain three-part version', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  /**
   * Deliberately separate numbers, asserted here so a future release does not
   * "tidy" them into one. `output_schema` describes the SHAPE of `--json`
   * output and moves only when that shape changes in a way a parser would
   * notice; `version` moves every release. A consumer pins the first and
   * reports the second.
   */
  it('is independent of the output schema version', () => {
    expect(OUTPUT_SCHEMA_VERSION).toBe(1)
  })
})
