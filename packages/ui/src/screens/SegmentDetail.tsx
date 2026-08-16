import type { ApiClient } from '../api/client.js'

/**
 * Stub, replaced in full by Task 7. Exists now only so `Router.tsx` has
 * somewhere for `/segments/:id` to go -- the props shape matches every
 * other detail-style screen (`client`, `onUnauthorized`) so Task 7 can fill
 * this in without touching the route registration again.
 */
export function SegmentDetail(_props: { client: ApiClient; onUnauthorized?: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-lg font-semibold">Segment</h1>
      <p className="text-sm text-muted-foreground">Coming soon.</p>
    </div>
  )
}
