import { buildSnippet, normalizeHost } from '@lyraflow/core'
import { SNIPPET_METHODS } from '@lyraflow/sdk-browser'
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
          <pre
            data-testid="install-snippet"
            className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-foreground"
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
