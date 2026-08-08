import { readFileSync } from 'node:fs'
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
 */
const MAX_GZIP_BYTES = 5 * 1024

describe('bundle size', () => {
  it('stays under the ceiling', () => {
    const bundle = readFileSync(join(import.meta.dirname, '..', 'dist', 'lyraflow.js'))
    const gzipped = gzipSync(bundle, { level: 9 }).byteLength
    expect(gzipped).toBeLessThanOrEqual(MAX_GZIP_BYTES)
  })
})
