import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

/**
 * The single discipline that stops a browser SDK becoming a framework.
 *
 * Reads BUILT output, so `pnpm build` must have run — the same requirement
 * schema-version.test.ts already imposes. A failure here is not a licence to
 * raise the number: cut scope instead. It is also what catches a value import
 * from @lyraflow/core accidentally pulling Zod (~13KB gzipped) into the bundle.
 *
 * `scripts/clean.mjs` removes `dist/lyraflow.js` before every build, ahead
 * of both `tsc -b` and esbuild, so a failed build leaves no bundle rather
 * than a stale, previously-passing one. This test asserts the file exists —
 * with a message that says what to run — before it reads a byte of it, so a
 * missing bundle fails as "run pnpm build", not as a raw ENOENT stack.
 */
const MAX_GZIP_BYTES = 5 * 1024
const BUNDLE_PATH = join(import.meta.dirname, '..', 'dist', 'lyraflow.js')

describe('bundle size', () => {
  it('stays under the ceiling', () => {
    expect(existsSync(BUNDLE_PATH), 'dist/lyraflow.js is missing — run pnpm build first').toBe(true)

    const bundle = readFileSync(BUNDLE_PATH)
    const gzipped = gzipSync(bundle, { level: 9 }).byteLength
    expect(gzipped).toBeLessThanOrEqual(MAX_GZIP_BYTES)
  })
})
