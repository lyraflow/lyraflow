import { describe, expect, it } from 'vitest'
import { RangePresetSchema, SHARED_PRESETS, resolvePreset } from './range.js'

const NOW = new Date('2026-09-05T12:00:00.000Z')

describe('resolvePreset', () => {
  it('auto is undefined', () => {
    expect(resolvePreset('auto', NOW)).toBeUndefined()
  })

  it('each preset ends at now and spans its days', () => {
    const days = { '24h': 1, '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 } as const
    for (const p of SHARED_PRESETS) {
      if (p === 'auto') continue
      const r = resolvePreset(p, NOW)
      expect(r?.until.toISOString()).toBe(NOW.toISOString())
      expect(r?.since.toISOString()).toBe(
        new Date(NOW.getTime() - days[p] * 86_400_000).toISOString(),
      )
    }
  })

  it('both ends come from the one clock reading it was given', () => {
    // The whole reason `now` is a parameter: a `since` and an `until`
    // derived from two separate readings describe a window nobody asked
    // for. `until` must be the exact object's instant, not a fresh one.
    const r = resolvePreset('7d', NOW)
    expect(r?.until.getTime()).toBe(NOW.getTime())
    expect((r?.until.getTime() ?? 0) - (r?.since.getTime() ?? 0)).toBe(7 * 86_400_000)
  })
})

describe('RangePresetSchema', () => {
  it('accepts exactly the seven presets and nothing else', () => {
    for (const p of SHARED_PRESETS) expect(RangePresetSchema.safeParse(p).success).toBe(true)
    for (const bad of ['custom', '1d', '', '7D', 'auto ']) {
      expect(RangePresetSchema.safeParse(bad).success).toBe(false)
    }
  })
})
