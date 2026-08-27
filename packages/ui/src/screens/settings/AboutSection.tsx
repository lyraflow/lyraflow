import type { ApiClient } from '../../api/client.js'
import { useVersion } from '../../app/useVersion.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'

/**
 * What release this install is running.
 *
 * Read from `GET /v1/meta` rather than baked into this bundle at build time.
 * The two agree in a real install -- one image builds the server and the UI
 * from one commit -- but the question an operator is asking is "what is
 * running", and only the server can answer that. A constant compiled in here
 * would answer "what was this page built from", which is the same number
 * right up until the moment it matters.
 *
 * Fetches on its own, keyed on `client` alone, rather than joining
 * `Settings`'s `[client, activeId]` effect: the version is a property of the
 * install, not of the selected project, and folding it in would re-ask the
 * server for an unchanging string on every project switch.
 */
export function AboutSection(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  // Shared with the sidebar's footer -- see the hook for why the two fetch
  // separately rather than sharing one result.
  const { version, failed } = useVersion(client, onUnauthorized)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Install</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="text-sm">
          <dt className="text-muted-foreground">Version</dt>
          <dd className="text-base font-semibold text-foreground">
            {/* A skeleton, never an empty value: a blank beside the label
             * "Version" reads as an install that has none, which is a worse
             * answer than "not loaded yet". */}
            {version ?? <Skeleton data-testid="install-version-loading" className="h-6 w-24" />}
          </dd>
        </dl>

        {version !== null && (
          /* `noreferrer` alongside `noopener` is doing real work, the same
           * work it does on `Shell.tsx`'s Star link: without it the outbound
           * request carries this page's URL, which on a self-hosted install
           * is the operator's own hostname. That is private infrastructure
           * and it is not GitHub's to learn. */
          <a
            href={`https://github.com/lyraflow/lyraflow/releases/tag/v${version}`}
            target="_blank"
            rel="noreferrer noopener"
            className="w-fit text-sm text-muted-foreground underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            Release notes
          </a>
        )}

        {failed && (
          <p role="alert" className="text-sm text-destructive">
            Could not read the version from the server. Reload to try again.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
