import { Label } from '../../components/ui/label.js'

/** The four ranges this screen offers. Deliberately a fixed set, not free
 * text -- the server bills a range by how much ClickHouse it scans, and an
 * unbounded custom range from this screen is exactly the cost surface the
 * server's own `422` (query timeout) exists to defend. */
export const RANGE_DAY_OPTIONS = [1, 7, 30, 90] as const
export type RangeDays = (typeof RANGE_DAY_OPTIONS)[number]

/** The range a funnel is run against on open, before any explicit choice. */
export const DEFAULT_RANGE_DAYS: RangeDays = 7

/**
 * A plain native `<select>`, not the Radix combobox used elsewhere in this
 * app -- deliberately. A range choice here must NOT trigger a re-run by
 * itself (that is the whole point of the stale/Run split in
 * `FunnelDetail`), so all this needs to do is report a plain change event,
 * and a native element is what lets `@testing-library/user-event`'s
 * `selectOptions` -- which only understands a native `<select>` -- drive it
 * directly in tests, the same way a real operator drives it with a
 * keyboard.
 *
 * Emits `days`, never a computed `since`: computing the ISO string is
 * `FunnelDetail`'s job, done at the moment it actually calls `runFunnel`,
 * so the value sent is always "now minus N days" as of the click that
 * triggers the run, not as of whenever this picker last changed.
 */
export function RangePicker(props: { days: RangeDays; onChange: (days: RangeDays) => void }) {
  const { days, onChange } = props
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="funnel-range">Range</Label>
      <select
        id="funnel-range"
        value={days}
        onChange={(e) => onChange(Number(e.target.value) as RangeDays)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        {RANGE_DAY_OPTIONS.map((d) => (
          <option key={d} value={d}>
            Last {d} day{d === 1 ? '' : 's'}
          </option>
        ))}
      </select>
    </div>
  )
}
