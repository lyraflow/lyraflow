import type { Usage } from '../../api/types.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Skeleton } from '../../components/ui/skeleton.js'

function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * This month's counts against the project's quota.
 *
 * `monthly_event_quota: null` means UNLIMITED and is what every project
 * carries by default -- `Number(null)` is `0` (the opposite of the truth:
 * it would read as a project that can accept nothing) and a percentage of
 * `null` is `NaN`. Both are avoided structurally: the null case renders the
 * word "Unlimited" and never reaches the ratio calculation at all.
 */
export function UsageSection(props: { usage: Usage | null }) {
  const { usage } = props

  if (usage == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Usage this month</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  const { month, events_accepted, events_rejected, events_throttled, monthly_event_quota } = usage
  const quotaLabel = monthly_event_quota == null ? 'Unlimited' : formatNumber(monthly_event_quota)
  const pct =
    monthly_event_quota == null
      ? null
      : Math.min(100, (events_accepted / monthly_event_quota) * 100)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage this month</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{month}</p>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Accepted</dt>
            <dd className="text-base font-semibold text-foreground">
              {formatNumber(events_accepted)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Rejected</dt>
            <dd className="text-base font-semibold text-destructive">
              {formatNumber(events_rejected)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Throttled</dt>
            <dd className="text-base font-semibold text-warning">
              {formatNumber(events_throttled)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Quota</dt>
            <dd className="text-base font-semibold text-foreground">{quotaLabel}</dd>
          </div>
        </dl>
        {pct != null && (
          // A native <progress> rather than a `role="progressbar"` div --
          // inherently accessible (focusable and announced) with no extra
          // ARIA plumbing of our own to get right or drift out of sync.
          <progress
            className="h-2 w-full overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary"
            value={Math.round(pct)}
            max={100}
            // Deliberately doesn't say "quota" -- the settings screen's
            // limits section (added later) has an input labelled "Monthly
            // event quota", and `getByLabelText(/quota/i)` in tests would
            // otherwise match this element too, since the query matches
            // any `aria-label`, not only form controls.
            aria-label="Events accepted against the monthly limit"
          />
        )}
      </CardContent>
    </Card>
  )
}
