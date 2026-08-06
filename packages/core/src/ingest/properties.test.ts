import { describe, expect, it } from 'vitest'
import { routeProperties } from './properties.js'

describe('routeProperties', () => {
  it('routes finite numbers to properties_num', () => {
    expect(routeProperties({ amount: 42.5 })).toEqual({
      properties: {},
      properties_num: { amount: 42.5 },
    })
  })

  it('routes strings to properties', () => {
    expect(routeProperties({ plan: 'trial' })).toEqual({
      properties: { plan: 'trial' },
      properties_num: {},
    })
  })

  it('stringifies booleans into properties', () => {
    expect(routeProperties({ paid: true, trial: false })).toEqual({
      properties: { paid: 'true', trial: 'false' },
      properties_num: {},
    })
  })

  it('drops null and undefined rather than storing empty strings', () => {
    expect(routeProperties({ a: null, b: undefined as never })).toEqual({
      properties: {},
      properties_num: {},
    })
  })

  it('drops non-finite numbers, which ClickHouse Float64 cannot represent usefully', () => {
    expect(routeProperties({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({
      properties: {},
      properties_num: {},
    })
  })

  it('truncates keys longer than 128 characters', () => {
    const key = 'k'.repeat(200)
    const out = routeProperties({ [key]: 'v' })
    expect(Object.keys(out.properties)[0]).toHaveLength(128)
  })
})
