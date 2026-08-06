export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * Device clocks are frequently wrong. An unclamped client timestamp poisons
 * every time-windowed segment, and the resulting bug is extremely hard to
 * trace back to its cause, so clamp at the edge instead.
 */
export function clampTimestamp(
  clientTimestamp: string | undefined,
  now: Date,
  maxSkewMs: number = MAX_CLOCK_SKEW_MS,
): Date {
  if (!clientTimestamp) return now

  const parsed = new Date(clientTimestamp)
  const ms = parsed.getTime()
  if (Number.isNaN(ms)) return now

  const nowMs = now.getTime()
  if (ms > nowMs + maxSkewMs) return new Date(nowMs + maxSkewMs)
  if (ms < nowMs - maxSkewMs) return new Date(nowMs - maxSkewMs)
  return parsed
}
