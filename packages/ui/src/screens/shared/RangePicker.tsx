import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { CUSTOM, RANGE_PRESETS, type RangeChoice } from './range.js'

/**
 * The range control both Trends and Retention render.
 *
 * A preset list rather than two date boxes by default, because the common
 * case is "the last N days" and making somebody type two dates for it is a
 * tax. `Between two dates…` reveals the boxes for the case presets cannot
 * reach -- which is not rare: a demo or a staging project whose data stopped
 * weeks ago is invisible to every relative window.
 *
 * `type="date"`, not `datetime-local`: both screens bucket by day at their
 * finest useful resolution here, and asking for a time would imply a
 * precision the buckets do not have.
 */
export function RangePicker(props: {
  id: string
  value: RangeChoice
  onChange: (next: RangeChoice) => void
}) {
  const { id, value, onChange } = props
  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>Range</Label>
        <select
          id={id}
          aria-label="Range"
          value={value.preset}
          onChange={(e) => onChange({ ...value, preset: e.target.value as RangeChoice['preset'] })}
          className="h-9 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
        >
          {RANGE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {value.preset === CUSTOM && (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${id}-from`}>From</Label>
            <Input
              id={`${id}-from`}
              aria-label="From"
              type="date"
              value={value.from}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className="w-40"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`${id}-to`}>To</Label>
            <Input
              id={`${id}-to`}
              aria-label="To"
              type="date"
              value={value.to}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className="w-40"
            />
          </div>
        </>
      )}
    </>
  )
}
