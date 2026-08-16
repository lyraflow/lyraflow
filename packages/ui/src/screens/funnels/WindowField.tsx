import { useId } from 'react'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

const PER_UNIT = { minutes: 60, hours: 3600, days: 86400 } as const
export type WindowUnit = keyof typeof PER_UNIT

/**
 * `Number.isSafeInteger`, not `Number.isInteger`. The latter is true for
 * 1e20, which reaches Postgres as a bigint bind and returns 503 -- an input
 * error wearing an outage's clothes. This is the fifth home of that bug in
 * this repository, so the product is checked too, not only the input:
 * `Number.MAX_SAFE_INTEGER` days is itself a safe integer, but multiplied by
 * 86400 it is not, so the RESULT is checked again after the multiply.
 */
export function toWindowSeconds(value: number, unit: WindowUnit): number | null {
  if (!Number.isSafeInteger(value) || value <= 0) return null
  const seconds = value * PER_UNIT[unit]
  if (!Number.isSafeInteger(seconds)) return null
  return seconds
}

/**
 * The inverse of `toWindowSeconds`, used only to seed the builder from an
 * already-saved funnel (`window_seconds` on the wire, this field's two
 * inputs on screen). Picks the largest unit that divides evenly so a
 * funnel saved as "7 days" reopens showing "7 days", not "168 hours".
 *
 * Every value THIS UI can itself produce is a whole multiple of 60 (there is
 * no seconds option below `minutes`), so the no-unit-divides-evenly branch
 * only fires for a `window_seconds` written by something else entirely --
 * a future writer, not the CLI, which does not touch funnels at all today.
 * Falling back to whole minutes, rounded down, loses sub-minute precision
 * on redisplay rather than refusing to open the funnel; the stored value on
 * the server is untouched unless the operator explicitly changes and saves
 * the window.
 */
export function secondsToWindowInput(seconds: number): { value: number; unit: WindowUnit } {
  if (seconds % PER_UNIT.days === 0) return { value: seconds / PER_UNIT.days, unit: 'days' }
  if (seconds % PER_UNIT.hours === 0) return { value: seconds / PER_UNIT.hours, unit: 'hours' }
  if (seconds % PER_UNIT.minutes === 0)
    return { value: seconds / PER_UNIT.minutes, unit: 'minutes' }
  return { value: Math.max(1, Math.floor(seconds / PER_UNIT.minutes)), unit: 'minutes' }
}

/**
 * A number input paired with a unit select, reporting both together on
 * every change so the caller always has a coherent `(value, unit)` pair to
 * feed `toWindowSeconds` -- never a stale value against a freshly changed
 * unit or vice versa.
 *
 * Renders its own inline validity note keyed off `toWindowSeconds` itself,
 * not a second, hand-rolled copy of "positive safe integer" -- the whole
 * point of Task 5's fifth-occurrence bug is that this check must live in
 * exactly one place.
 */
export function WindowField(props: {
  value: number
  unit: WindowUnit
  onChange: (value: number, unit: WindowUnit) => void
}) {
  const { value, unit, onChange } = props
  const id = useId()
  const seconds = toWindowSeconds(value, unit)

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Window</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={1}
          step={1}
          value={value}
          aria-invalid={seconds == null}
          onChange={(e) => onChange(Number(e.target.value), unit)}
          className="w-24"
        />
        <select
          aria-label="Window unit"
          value={unit}
          onChange={(e) => onChange(value, e.target.value as WindowUnit)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
      {seconds == null && (
        <p className="text-xs text-destructive">
          Enter a whole number of {unit} greater than zero, small enough to convert to seconds.
        </p>
      )}
    </div>
  )
}
