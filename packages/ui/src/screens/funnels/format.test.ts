import { describe, expect, it } from 'vitest'
import { formatCount, formatPercent, formatRelative } from './format.js'

describe('formatPercent', () => {
  it('renders a server rate as one decimal place', () => {
    expect(formatPercent(0.4078)).toBe('40.8%')
  })
  it('renders exact zero as 0%, never NaN or an em dash', () => {
    expect(formatPercent(0)).toBe('0%')
  })
  it('renders 1 as 100%', () => {
    expect(formatPercent(1)).toBe('100%')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-08-15T12:00:00.000Z')
  it('states the value, not merely a shape', () => {
    expect(formatRelative('2026-08-15T11:58:00.000Z', now)).toBe('2 minutes ago')
  })
  it('handles a run older than a day', () => {
    expect(formatRelative('2026-08-13T12:00:00.000Z', now)).toBe('2 days ago')
  })
})
