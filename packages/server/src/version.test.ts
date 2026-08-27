import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_VERSION } from './version.js'

/**
 * `SERVER_VERSION` is a hand-written literal, for the same reason
 * `CLI_VERSION` and the SDK's `VERSION` are: the built server runs out of
 * `dist/`, and resolving its own `package.json` from there at runtime
 * depends on what the Docker image happens to copy beside the output. A
 * literal has no such dependency.
 *
 * The cost of a literal is that it can drift, and this is the only thing
 * that stops it. `GET /v1/meta` serves this number to the Settings screen,
 * where an operator reads it to decide whether to upgrade and quotes it
 * into a bug report -- a stale value there is worse than no value, because
 * it is believed.
 */
const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

describe('SERVER_VERSION', () => {
  it('matches the package manifest, which is what a release bumps', () => {
    expect(SERVER_VERSION).toBe(manifest.version)
  })

  it('is a plain three-part version', () => {
    // The Settings screen builds a release-notes URL out of this
    // (`/releases/tag/v<version>`). Anything needing escaping would produce
    // a link that silently 404s rather than failing anywhere visible.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
