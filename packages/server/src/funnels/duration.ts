/**
 * A window length in seconds, as a phrase a person would say.
 *
 * `604800-second` is a correct description of a funnel's window and nobody
 * has ever said it. The string it appears in is a warning shown on the funnel
 * screen — the one piece of copy on that page whose whole job is to be
 * understood quickly — and it also lands in screenshots on the marketing
 * site, where raw seconds read as an unfinished product rather than a precise
 * one.
 *
 * Exact division only, largest unit first, so the phrase never rounds: a
 * window is a number an operator typed into a form with a unit beside it, and
 * every value that form can produce divides evenly here. Anything that does
 * not — a hand-written API call of 90 seconds, say — keeps its seconds rather
 * than being described as "1-minute", which would be a smaller number than
 * the funnel actually used.
 */
const PER_UNIT = [
  [86_400, 'day'],
  [3_600, 'hour'],
  [60, 'minute'],
] as const

export function describeWindow(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return `${seconds}-second`
  for (const [size, unit] of PER_UNIT) {
    if (seconds % size === 0) return `${seconds / size}-${unit}`
  }
  return `${seconds}-second`
}
