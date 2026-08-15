import { describe, expect, it } from 'vitest'
import { buildSnippet, normalizeHost } from './build.js'

/**
 * This file covers `buildSnippet` and its two module-private helpers
 * (`escapeHtmlAttr`, `jsStringLiteral`), plus `normalizeHost` — the pieces
 * that moved here from `packages/cli/src/api/commands/snippet.ts` (Task 1 of
 * the settings-wizard plan). Every case below is a DIRECT unit test of the
 * exported functions, not a run of the CLI's `runSnippet` command — the CLI
 * and web-UI-level tests exercising the same behaviour THROUGH the command
 * (`packages/cli/src/api/commands/snippet.test.ts`,
 * `snippet-bundle.test.ts`) stay in the CLI package, since they cover the
 * command's own request/response wiring and output-formatting contract, not
 * this module.
 *
 * The two escaping helpers stay module-private (per the task brief) — every
 * case that exercises them does so by calling `buildSnippet` with an input
 * shaped to reach the guard, exactly as `snippet.test.ts` did before the
 * move.
 */

const METHODS = ['track', 'init', 'identify'] as const
const HOST = 'https://analytics.example.test'
const WRITE_KEY = 'wk_test_key'

/** Structural parse of the snippet's own script elements — proves an
 * encoding guard is actually load-bearing (an injected value that breaks it
 * produces a DIFFERENT element count and a syntax error, not merely "the
 * sentinel string is absent somewhere in the blob"). */
function extractScriptBodies(html: string): string[] {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  const bodies: string[] = []
  let m = re.exec(html)
  while (m !== null) {
    bodies.push(m[1] ?? '')
    m = re.exec(html)
  }
  return bodies
}

describe('normalizeHost', () => {
  it('strips a trailing slash — the shape a real person actually hits', () => {
    expect(normalizeHost(`${HOST}/`)).toBe(HOST)
  })

  it('discards a path entirely, including one carrying a quote', () => {
    expect(normalizeHost(`${HOST}/x'y`)).toBe(HOST)
  })

  it('discards a path carrying a script-closing tag', () => {
    expect(normalizeHost(`${HOST}/</script><script>alert(1)</script>`)).toBe(HOST)
  })

  it('discards a path carrying a backslash', () => {
    expect(normalizeHost(`${HOST}/a\\b`)).toBe(HOST)
  })

  it('keeps a port', () => {
    expect(normalizeHost('http://127.0.0.1:4600')).toBe('http://127.0.0.1:4600')
  })

  it('discards a sub-path prefix', () => {
    expect(normalizeHost(`${HOST}/some/sub/path`)).toBe(HOST)
  })

  it('works over plain http, not just https', () => {
    expect(normalizeHost('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('throws on an unparseable host', () => {
    // Unlike the CLI's own call site (which runs this only after `Client`
    // has already parsed the identical string successfully, making a throw
    // here provably unreachable there), a direct caller of this exported
    // function has no such guarantee upstream — this pins that it really
    // does throw, not silently return a garbage string.
    expect(() => normalizeHost('not a url at all')).toThrow()
  })
})

describe('buildSnippet', () => {
  it('embeds the identical host in BOTH substitution sites (src and init)', () => {
    // A wrong host in only one of the two sites (the bundle loads from the
    // right place, but every event goes to someone else's server, or vice
    // versa) is the failure mode a single "does the text contain HOST
    // somewhere" assertion cannot catch.
    const text = buildSnippet(HOST, WRITE_KEY, METHODS)
    expect(text).toContain(`src="${HOST}/lyraflow.js"`)
    expect(text).toContain(`host: "${HOST}"`)
  })

  it("builds the stub's method array from the methods parameter, not a fixed list", () => {
    const text = buildSnippet(HOST, WRITE_KEY, METHODS)
    for (const m of METHODS) expect(text).toContain(`"${m}"`)
  })

  it('does not include a method absent from the methods parameter', () => {
    const text = buildSnippet(HOST, WRITE_KEY, ['track'])
    expect(text).toContain('"track"')
    expect(text).not.toContain('"identify"')
  })

  describe('write key encoding', () => {
    // The write key comes straight from the caller (in the CLI, `GET
    // /v1/project`'s response body) — server-supplied, and unlike `host` it
    // is NEVER normalised (there is no "origin" to reduce it to).
    // `jsStringLiteral`'s `</` guard is LOAD-BEARING here, not
    // belt-and-suspenders: without it, a write key shaped like this closes
    // the inline `<script>` element early and whatever follows is parsed
    // and executed as real markup on every page that pastes the snippet.
    const INJECTED_KEY = 'wk_"+alert(1)+"</script><script>alert(2)</script>'

    it('keeps the snippet at exactly three script elements, each parseable, with the key round-tripping exactly', () => {
      const text = buildSnippet(HOST, INJECTED_KEY, METHODS)

      const bodies = extractScriptBodies(text)
      expect(bodies).toHaveLength(3)
      for (const body of bodies) {
        expect(() => new Function(body)).not.toThrow()
      }

      // Not just "does not crash" — the init() block's own `writeKey`
      // literal must decode to EXACTLY the original injected value.
      const initBody = bodies[2] ?? ''
      const literalMatch = /writeKey:\s*("(?:[^"\\]|\\.)*")/.exec(initBody)
      expect(literalMatch).not.toBeNull()
      const undoScriptGuard = (literalMatch?.[1] ?? '').replace(/<\\\//g, '</')
      expect(JSON.parse(undoScriptGuard)).toBe(INJECTED_KEY)
    })
  })

  describe('HTML attribute encoding', () => {
    // `escapeHtmlAttr` is belt-and-suspenders for a properly normalised
    // host — a real URL `origin` structurally cannot contain `&`/`"`/`<`/
    // `>` — which is exactly why nothing in the CLI's own call path can
    // reach this guard: `normalizeHost` always runs first there. This
    // module's contract only says `originHost` "MUST already be a
    // normalized origin"; nothing enforces that at the type level, so a
    // caller that skips `normalizeHost` (or passes a hand-built string) can
    // still reach `escapeHtmlAttr`'s guard directly. This exercises it
    // rather than leaving it permanently unreachable in the test suite.
    it('escapes HTML-attribute-breaking characters in a raw (non-normalized) host', () => {
      // Scoped to the `src="..."` ATTRIBUTE VALUE ALONE, not the whole
      // snippet text — `originHost` is also substituted a second time via
      // `jsStringLiteral` (the init call's `host:` literal), which encodes
      // the very same forbidden characters its own way. Scanning the whole
      // text for the forbidden substring would make this test fail just as
      // readily when `jsStringLiteral`'s guard breaks as when this one
      // does, which pins nothing about `escapeHtmlAttr` specifically —
      // exactly the "several guards removable together" failure mode this
      // repo's own mutation-testing notes warn about. Extracting only the
      // `src` attribute isolates the one guard this test claims to cover.
      const raw = `${HOST}"><script>alert(1)</script>`
      const text = buildSnippet(raw, WRITE_KEY, METHODS)
      const srcMatch = /<script async src="([\s\S]*?)"><\/script>/.exec(text)
      expect(srcMatch).not.toBeNull()
      const srcAttr = srcMatch?.[1] ?? ''
      expect(srcAttr).not.toContain('"><script>alert(1)</script>')
      expect(srcAttr).toBe(`${HOST}&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;/lyraflow.js`)
    })
  })
})
