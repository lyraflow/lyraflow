import { describe, expect, it } from 'vitest'
import type { Funnel, ResolvedTile, RetentionReport, TrendReport } from '../../api/types.js'
import { DEFAULT_RANGE, type RangeChoice } from '../shared/range.js'
import {
  ceilingFor,
  funnelRangeOf,
  retentionParamsOf,
  trendParamsOf,
  trendQueryOf,
} from './tileRequest.js'

const NOW = new Date('2026-09-03T12:00:00.000Z')
const T = '2026-09-01T00:00:00.000Z'
const preset = (id: RangeChoice['preset']): RangeChoice => ({ preset: id, from: '', to: '' })

const trend: TrendReport = {
  id: 1,
  name: 'Signups',
  event: 'signup',
  interval: '1d',
  group_by: 'attribute:country',
  where: [{ property: 'plan', operator: '=', value: 'pro' }],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}
const retention: RetentionReport = {
  id: 2,
  name: 'Weekly',
  definition_version: 1,
  start_event: 'signup',
  return_event: 'login',
  start_where: [],
  return_where: [],
  granularity: 'day',
  periods: 8,
  segment_id: 5,
  stale: false,
  created_at: T,
  updated_at: T,
}
const funnel = { id: 3, name: 'F', stale: false } as unknown as Funnel

const tileOf = (kind: ResolvedTile['kind'], report: unknown): ResolvedTile =>
  ({ kind, report_id: 1, width: 'half', report }) as ResolvedTile

describe('trendParamsOf / trendQueryOf', () => {
  it('builds exactly the query the Trends screen sends for the stored definition', () => {
    const q = trendQueryOf(trendParamsOf(trend, preset('7d')), NOW)
    expect(q).toEqual({
      interval: '1d',
      since: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
      until: NOW.toISOString(),
      event: 'signup',
      group_by: 'attribute:country',
      where: JSON.stringify(trend.where),
    })
  })
  it('omits since/until under auto, and omits where and group_by when empty', () => {
    const q = trendQueryOf(
      trendParamsOf({ ...trend, group_by: null, where: [] }, DEFAULT_RANGE),
      NOW,
    )
    expect(q).toEqual({ interval: '1d', event: 'signup' })
  })
})

describe('retentionParamsOf', () => {
  it('carries the segment and the stored definition into toRequest', () => {
    const p = retentionParamsOf(retention, preset('30d'))
    expect(p).toMatchObject({
      start: 'signup',
      return: 'login',
      granularity: 'day',
      periods: 8,
      segmentId: 5,
    })
  })
})

describe('funnelRangeOf', () => {
  it('sends a relative preset as days, never as a computed since', () => {
    expect(funnelRangeOf(preset('24h'), NOW)).toEqual({ days: 1 })
    expect(funnelRangeOf(preset('7d'), NOW)).toEqual({ days: 7 })
    expect(funnelRangeOf(preset('30d'), NOW)).toEqual({ days: 30 })
    expect(funnelRangeOf(preset('90d'), NOW)).toEqual({ days: 90 })
  })
  it('sends nothing under auto, so the server applies its own default', () => {
    expect(funnelRangeOf(DEFAULT_RANGE, NOW)).toEqual({})
  })
  it('sends a custom range as since/until', () => {
    const r = funnelRangeOf({ preset: 'custom', from: '2026-08-01', to: '2026-08-10' }, NOW)
    expect(r).toEqual({ since: '2026-08-01T00:00:00.000Z', until: '2026-08-10T23:59:59.999Z' })
  })
})

describe('ceilingFor', () => {
  it('a trend at 1m over 30d exceeds the bucket ceiling', () => {
    expect(ceilingFor(tileOf('trend', { ...trend, interval: '1m' }), preset('30d'), NOW)).toEqual({
      kind: 'buckets',
      count: 43_200,
      max: 1000,
    })
  })
  it('a daily trend over 30d does not', () => {
    expect(ceilingFor(tileOf('trend', trend), preset('30d'), NOW)).toBeNull()
  })
  it('daily retention over 90d exceeds the cohort ceiling', () => {
    expect(ceilingFor(tileOf('retention', retention), preset('90d'), NOW)).toEqual({
      kind: 'cohorts',
      count: 90,
      max: 60,
    })
  })
  it('a funnel under 180d, 365d or a long custom span exceeds the funnel range cap', () => {
    expect(ceilingFor(tileOf('funnel', funnel), preset('180d'), NOW)).toEqual({
      kind: 'funnel_days',
      max: 90,
    })
    expect(ceilingFor(tileOf('funnel', funnel), preset('365d'), NOW)).toEqual({
      kind: 'funnel_days',
      max: 90,
    })
    expect(
      ceilingFor(
        tileOf('funnel', funnel),
        { preset: 'custom', from: '2026-01-01', to: '2026-06-01' },
        NOW,
      ),
    ).toEqual({ kind: 'funnel_days', max: 90 })
  })
  it('a funnel under 90d or auto is within the cap', () => {
    expect(ceilingFor(tileOf('funnel', funnel), preset('90d'), NOW)).toBeNull()
    expect(ceilingFor(tileOf('funnel', funnel), DEFAULT_RANGE, NOW)).toBeNull()
  })
  it('a deleted report has no ceiling to check', () => {
    expect(ceilingFor(tileOf('trend', null), preset('30d'), NOW)).toBeNull()
  })
})
