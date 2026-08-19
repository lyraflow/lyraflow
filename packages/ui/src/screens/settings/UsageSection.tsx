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
 *
 * `quota` is a SEPARATE prop from `usage.monthly_event_quota`, deliberately
 * (IMPORTANT 1 from the whole-branch review). `usage` only ever changes from
 * `Settings`'s own `[client, activeId]` fetch effect -- a quota saved via
 * `LimitsSection` writes into project CONTEXT through `updateProject`, which
 * that effect never re-runs for, so `usage.monthly_event_quota` went stale
 * the instant a save succeeded: an unlimited project stayed "Unlimited"
 * after a quota was set, and the reverse was worse -- lowering a quota left
 * the bar drawn against the OLD, larger denominator, so a now-over-quota
 * project could render as near-empty. `Settings` passes the quota straight
 * from the context row `updateProject` already keeps correct instead, so
 * this card can never disagree with what was just saved, with no second
 * fetch required.
 */
export function UsageSection(props: { usage: Usage | null; quota: number | null }) {
  const { usage, quota } = props

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

  const { month, events_accepted, events_rejected, events_throttled, events_bot } = usage
  const quotaLabel = quota == null ? 'Unlimited' : formatNumber(quota)
  const pct = quota == null ? null : Math.min(100, (events_accepted / quota) * 100)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage this month</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{month}</p>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
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
            {/*
              Deliberately NOT styled as a fault. A bot drop is the filter
              working, not the integration failing -- these events used to be
              counted as "Rejected" in red, which read as an error on traffic
              nobody needs to act on. Its value is that it is VISIBLE: with
              the column split out and this tile missing, the same crawler
              traffic showed up nowhere at all.
            */}
            <dt className="text-muted-foreground">Bot</dt>
            <dd className="text-base font-semibold text-foreground">{formatNumber(events_bot)}</dd>
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
