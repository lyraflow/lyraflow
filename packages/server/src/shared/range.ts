import { z } from 'zod'

/**
 * The presets the shared page may ask for -- the operator's picker minus
 * `custom`. Presets and not dates because the key space of the result
 * cache (`ResultCache` in limits.ts) is presets x tiles per link, and a
 * date pair is unbounded: a caller free to name arbitrary bounds could
 * mint an unlimited number of distinct cache keys against one token, which
 * is the same reasoning `SHARED_CACHE_MAX_ENTRIES` bounds the map with.
 */
export const SHARED_PRESETS = ['auto', '24h', '7d', '30d', '90d', '180d', '365d'] as const
export type RangePreset = (typeof SHARED_PRESETS)[number]
export const RangePresetSchema = z.enum(SHARED_PRESETS)

const PRESET_DAYS: Record<Exclude<RangePreset, 'auto'>, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '180d': 180,
  '365d': 365,
}

/**
 * ONE reading of the clock, passed in, so both ends of the window come from
 * the same instant -- the same fix `FUNNEL_DEFAULT_RANGE_MS` and
 * `resolveStatsWindow` exist for, where a `since` and an `until` derived
 * from two separate `Date.now()` calls describe a window nobody asked for.
 *
 * `undefined` for `auto`: each kind then applies its OWN default, which is
 * not a single span -- `resolveStatsWindow` scales a trend's default to its
 * interval, retention defaults to `periods` whole periods, and a funnel
 * falls back to `FUNNEL_DEFAULT_RANGE_MS`. Returning a fixed window here
 * for `auto` would silently override all three.
 */
export function resolvePreset(
  preset: RangePreset,
  now: Date,
): { since: Date; until: Date } | undefined {
  if (preset === 'auto') return undefined
  return { since: new Date(now.getTime() - PRESET_DAYS[preset] * 86_400_000), until: now }
}
