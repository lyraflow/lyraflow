// The subpath, NOT the package root -- `@lyraflow/core`'s root barrel
// (`index.ts`) re-exports `auth/password.ts`, which calls
// `promisify(scrypt)` at MODULE SCOPE, not inside a function. Rollup can
// tree-shake the unused `hashPassword` export itself, but it cannot prove
// that top-level call has no side effects, so it stays in the bundle --
// where `node:crypto`/`node:util` are externalized to an empty stub, and
// `Bm.promisify` (the stub) is undefined. The result was a `TypeError`
// thrown at module-evaluation time, before React ever mounts: a white
// screen with nothing in the console but the throw. `build.ts` has no
// internal imports, so this subpath resolves without pulling any of that
// in -- see `packages/core/package.json`'s `exports` map, which pins this
// path so a later refactor of `core`'s barrel can't silently break it
// again.
import { buildSnippet, normalizeHost } from '@lyraflow/core/snippet/build.js'
// The subpath here too, for a sibling reason (IMPORTANT 4 from the
// whole-branch review): `@lyraflow/sdk-browser`'s root barrel (`index.ts`)
// ends with a bare top-level `installGlobal()` call, which stamps
// `window.lyraflow` the moment the module evaluates -- no call required.
// This screen is served from the SAME origin as ingest, so importing the
// root barrel here silently defined `window.lyraflow` on the admin UI and
// pulled the whole tracking SDK into the admin bundle, invisibly: nothing
// throws, so `build-output.test.ts` (which can only catch a module-scope
// throw) never saw it. `snippet-methods.js` has no side-effecting imports
// of its own, so this subpath resolves without pulling any of that in --
// see `packages/sdk-browser/package.json`'s `exports` map.
import { SNIPPET_METHODS } from '@lyraflow/sdk-browser/snippet-methods.js'
import { useState } from 'react'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'

/**
 * The install snippet section -- the one thing on this page a person must
 * copy exactly. `buildSnippet` is the ONLY thing that ever produces the
 * markup: it is hardened against a naive host interpolation that shipped a
 * silent 404, and it escapes the write key separately for an HTML
 * attribute and a JS string literal. Building this by hand anywhere,
 * including here, reopens both.
 */
export function SnippetSection(props: { writeKey: string | null }) {
  const { writeKey } = props
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')

  // `window.location.origin` is always a well-formed absolute origin, so
  // `normalizeHost` cannot throw here the way it can for a caller-typed
  // host field -- see that function's own docstring for the distinction.
  const snippet =
    writeKey == null
      ? null
      : buildSnippet(normalizeHost(window.location.origin), writeKey, SNIPPET_METHODS)

  async function handleCopy() {
    if (snippet == null) return
    try {
      await navigator.clipboard.writeText(snippet)
      setCopyState('copied')
    } catch {
      // The async clipboard API REJECTS rather than silently no-ops: when
      // the document isn't focused, and it's unavailable entirely on a
      // non-secure origin that isn't localhost -- exactly what a
      // self-hoster on plain HTTP over a private network hits. Tell them
      // to copy by hand rather than failing without a trace.
      setCopyState('manual')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Install snippet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Paste this before the closing <code>&lt;/head&gt;</code> tag.
        </p>
        {snippet == null ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          // A text child, never `dangerouslySetInnerHTML` -- the snippet
          // is markup a browser will parse when pasted onto a page, not
          // markup this page itself should ever render.
          // `whitespace-pre-wrap break-words`, not just `overflow-x-auto`:
          // in the wizard's narrower card (`max-w-lg`, versus Settings' full
          // column) the box was narrow enough that lines ran off the right
          // edge mid-token -- reachable by scrolling, since the page itself
          // never overflowed, but with no visible affordance that a scroll
          // existed, so it read as mangled code rather than a snippet with
          // more off-screen (Finding 2, fix round 1). Wrapping removes the
          // clipped edge in either width, so nothing needs discovering.
          // `break-words`, not `break-all` (small fix from the whole-branch
          // review): `break-all` splits at every character regardless of
          // whether a natural break point exists, so it split ordinary
          // tokens mid-word too -- `writeKey` could render as `wri`/`teKey`.
          // `break-words` only forces a break INSIDE a word when the word
          // alone can't fit the line, so ordinary tokens stay intact and
          // only the genuinely unbreakable write key value ever splits.
          // `overflow-x-auto` stays as a backstop for anything that
          // genuinely cannot break (belt-and-suspenders, not load-bearing
          // now that wrapping is unconditional).
          <pre
            data-testid="install-snippet"
            className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground"
          >
            {snippet}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" onClick={handleCopy} disabled={snippet == null}>
            Copy snippet
          </Button>
          {copyState === 'copied' && <output className="text-sm text-success">Copied.</output>}
          {copyState === 'manual' && (
            <output className="text-sm text-warning">
              Could not copy automatically -- select the text above and copy it by hand.
            </output>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          The write key above is public by design -- it ships inside every page that loads this
          snippet. The project&apos;s server key, used from the CLI and any server-side integration,
          is shown once at creation and cannot be shown again: only its hash is ever stored.
        </p>
      </CardContent>
    </Card>
  )
}
