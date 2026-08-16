import type { ApiClient } from '../api/client.js'

/**
 * Stub, replaced in full by Task 4. Exists now only so `Router.tsx` has
 * somewhere for `/segments/new` and `/segments/:id/edit` to go -- the props
 * shape matches every other builder-style screen (`client`,
 * `onUnauthorized`) so Task 4 can fill this in without touching the route
 * registration again.
 */
export function SegmentBuilder(_props: { client: ApiClient; onUnauthorized?: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-lg font-semibold">New segment</h1>
      <p className="text-sm text-muted-foreground">Coming soon.</p>
    </div>
  )
}
