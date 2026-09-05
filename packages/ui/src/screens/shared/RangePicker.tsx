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
  /**
   * Drops `Between two dates…` from the list and never reveals the date
   * boxes, for a surface whose range vocabulary is only the presets.
   *
   * The shared viewer page (`screens/SharedDashboard.tsx`) is the one such
   * surface: `SHARED_RANGE_PRESETS` is the entire set the public run route
   * accepts, so a custom pair of dates there is a choice the server answers
   * with a 400. Filtering the OPTIONS rather than declining the value in
   * the handler is the point -- a control that offers something and then
   * refuses it is worse than one that never offered it.
   *
   * The date boxes are suppressed even when `value.preset` IS `custom`,
   * because a pasted `?range=custom&from=…` URL reaches `readRange` before
   * anything normalises it; `useSharedRange` rewrites that on mount, and
   * this makes the render in between honest rather than briefly offering a
   * range the page cannot run.
   */
  presetsOnly?: boolean
}) {
  const { id, value, onChange, presetsOnly } = props
  const presets = presetsOnly ? RANGE_PRESETS.filter((p) => p.id !== CUSTOM) : RANGE_PRESETS
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
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      {!presetsOnly && value.preset === CUSTOM && (
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
