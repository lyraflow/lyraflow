import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from './index.js'

describe('core', () => {
  it('exposes the app schema version', () => {
    expect(SCHEMA_VERSION).toBe(7)
  })
})
