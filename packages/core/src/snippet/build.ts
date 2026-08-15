/**
 * The install snippet builder — a paste-ready browser install snippet with a
 * project's own host and write key substituted in.
 *
 * Moved here from the CLI (`packages/cli/src/api/commands/snippet.ts`) so the
 * CLI and the web UI's settings screen share ONE implementation. A second,
 * hand-copied implementation in the UI would eventually drift and hand
 * operators a broken install line — this builder is hardened for reasons its
 * own function docstrings record at length (naive interpolation of the host
 * shipped `HOST//lyraflow.js` and a silent 404 in a real release, and the
 * write key is escaped separately for an HTML attribute and a JS string
 * literal), and that hardening is worth having in exactly one place.
 *
 * `methods` is a PARAMETER, not a value import of `SNIPPET_METHODS` from
 * `@lyraflow/sdk-browser` — `core` is pure domain logic with no package
 * dependencies, and `sdk-browser`'s own tests import `core`, so importing
 * `sdk-browser` from here would risk a project-reference cycle in `tsc -b`.
 * Every caller (the CLI, the web UI) imports the same `SNIPPET_METHODS`
 * constant and passes it in, so the "never retype the method list" guarantee
 * this module's own docstring used to make for the CLI alone now holds for
 * every caller.
 */

/**
 * Resolves `host` to the value that is actually safe, and actually
 * CORRECT, to embed in a browser snippet: the URL's `origin` alone
 * (scheme + hostname + port), discarding anything else (path, query,
 * trailing slash).
 *
 * This is not a lossy simplification of what the CLI's `Client` does — it IS
 * what `Client` does, made visible. Every request path the CLI ever sends
 * ("/v1/project", "/v1/schema/events", ...) is an ABSOLUTE-PATH reference
 * (starts with "/"), and per URL resolution rules `new URL(path, base)`
 * for an absolute-path reference discards the base's own path entirely —
 * confirmed directly: `new URL('/v1/project', 'https://h/sub/').href ===
 * 'https://h/v1/project'`, never `'https://h/sub/v1/project'`. Any path
 * configured in a caller's own host setting has therefore never affected a
 * single real request, in any command, before or after this fix —
 * `.origin` simply stops pretending otherwise in what gets printed.
 *
 * This is also the fix for the reported defect: naive `${host}/lyraflow.js`
 * string concatenation turns a bare trailing slash (`https://h/`) into
 * `https://h//lyraflow.js` — a different URL that 404s. `.origin` never
 * carries a trailing slash, so the double-slash cannot occur.
 *
 * Throws on an unparseable `host` — a real possibility for a caller that has
 * not already validated it elsewhere. The CLI's own call site
 * (`packages/cli/src/api/commands/snippet.ts`) runs this only after
 * `GET /v1/project` has already parsed the identical string successfully via
 * `Client`'s own `new URL(...)`, so a throw is provably unreachable there —
 * see that call site's own comment for why it is placed after the request
 * rather than before it. That is a property of the CLI's call site, not a
 * guarantee this function itself makes: a caller that has not already
 * validated `host` (a settings-screen form field, for instance) must expect
 * this to throw and handle it.
 */
export function normalizeHost(host: string): string {
  return new URL(host).origin
}

/**
 * Encodes a value for safe inclusion inside an HTML DOUBLE-quoted
 * attribute. Belt-and-suspenders over `normalizeHost` (a real URL
 * `origin` structurally cannot contain any of these characters — the URL
 * parser rejects or strips them before `.origin` is ever read) — kept as
 * an explicit, structural guarantee anyway rather than an assumption about
 * `URL`'s own behaviour that nothing here enforces, the same reasoning the
 * CLI's `output.ts` gives for hardening a value that module does not fully
 * control the shape of.
 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Encodes a value as a JS string literal safe to inline inside an inline
 * `<script>` element. `JSON.stringify` produces valid JS string syntax
 * (not just JSON) and correctly escapes quotes, backslashes and control
 * characters — but it does not know about the ONE extra rule inline
 * script content has that a JS parser does not: an HTML tokenizer closes
 * the `<script>` element on the first `</` it sees, regardless of what JS
 * string syntax says about where the string itself ends. The trailing
 * `.replace` turns `</` into `<\/` — a different token to the HTML
 * tokenizer (an escaped forward slash inside a string, not a closing tag)
 * that decodes to the identical JS string value. The standard mitigation
 * for embedding untrusted data inside an inline `<script>`.
 *
 * THIS FUNCTION HAS TWO CALLERS WITH DIFFERENT STAKES — do not delete the
 * `</` guard because the host caller "can't need it":
 *   - for `host` (`normalizeHost`'s output), this IS belt-and-suspenders —
 *     a real URL `origin` structurally cannot contain `</` at all, so the
 *     guard is provably unreachable there (see `escapeHtmlAttr`'s own
 *     docstring for the identical reasoning on the other substitution
 *     site).
 *   - for `write_key`, it is LOAD-BEARING. The write key comes straight
 *     from `GET /v1/project`'s response body — server-supplied, and never
 *     normalised the way `host` is. A project row containing
 *     `wk_"+alert(1)+"</script><script>alert(2)</script>` (a compromised
 *     or misconfigured self-hosted database, not a hypothetical) would,
 *     without this guard, close the inline `<script>` element early and
 *     have its OWN injected markup parsed and executed on every page that
 *     pastes this snippet — confirmed directly: `build.test.ts`'s
 *     write-key-injection test fails exactly this way with the guard
 *     removed. Keep it.
 */
function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/<\//g, '<\\/')
}

/**
 * The install snippet template — the stub's method array is built from
 * `methods`, never retyped, so a method missing from that list cannot be
 * silently dropped from the stub the way it was on the previous plan.
 * Matches the README's own block in structure; the two substitution
 * sites (`src`, `host`/`writeKey`) are properly encoded rather than bare
 * template concatenation — see `normalizeHost`/`escapeHtmlAttr`/
 * `jsStringLiteral`'s own docstrings for why bare substitution was unsafe.
 *
 * `originHost` MUST already be a normalized origin (`normalizeHost`'s
 * output) — this function does not re-derive it, so both substitution
 * sites below are guaranteed to embed the IDENTICAL host string.
 *
 * `methods` is passed in by the caller rather than imported from
 * `@lyraflow/sdk-browser`'s `SNIPPET_METHODS` — see this file's own module
 * docstring for why. Every caller must import that same constant so the
 * stub never drifts from the SDK's real callable surface.
 */
export function buildSnippet(
  originHost: string,
  writeKey: string,
  methods: readonly string[],
): string {
  const methodList = methods.map((m) => JSON.stringify(m)).join(',')
  const srcAttr = escapeHtmlAttr(originHost)
  const hostLiteral = jsStringLiteral(originHost)
  const writeKeyLiteral = jsStringLiteral(writeKey)
  return `<script>
  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];
  [${methodList}].forEach(function(m){
    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});
  }();
</script>
<script async src="${srcAttr}/lyraflow.js"></script>
<script>
  lyraflow.init({ host: ${hostLiteral}, writeKey: ${writeKeyLiteral} })
</script>`
}
