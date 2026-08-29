import { describe, expect, it } from 'vitest'
import { countIncomplete, readWhere, whereFromStored, writeWhere } from './where.js'

const ONE = { property: 'path', operator: '=' as const, value: '/register' }

describe('readWhere', () => {
  it('round-trips a list', () => {
    expect(readWhere(JSON.stringify([ONE]))).toEqual([ONE])
  })

  it('keeps a freshly added blank row', () => {
    // The reason this reader is structural rather than strict. Validating
    // against core's full schema dropped the editor's own new row
    // (`property: ''`, which is `min(1)`), and "Add predicate" looked like a
    // dead button. Finishedness is `countIncomplete`'s question, not this
    // one's.
    const blank = { property: '', operator: '=', value: '' }
    expect(readWhere(JSON.stringify([blank]))).toEqual([blank])
  })

  it('degrades garbage to nothing, so a truncated link still opens', () => {
    expect(readWhere('not json')).toEqual([])
    expect(readWhere(JSON.stringify({ property: 'path' }))).toEqual([])
    expect(readWhere(JSON.stringify([1, 'x', {}]))).toEqual([])
    expect(readWhere(null)).toEqual([])
  })

  it('keeps an attribute predicate, which names a column instead of a property', () => {
    const attr = { source: 'attribute', attribute: 'utm_source', operator: '=', value: 'x' }
    expect(readWhere(JSON.stringify([attr]))).toEqual([attr])
  })
})

describe('writeWhere', () => {
  it('returns null for an empty list, so the caller drops the parameter', () => {
    expect(writeWhere([])).toBeNull()
  })

  it('round-trips through readWhere', () => {
    const written = writeWhere([ONE])
    expect(written).not.toBeNull()
    expect(readWhere(written)).toEqual([ONE])
  })
})

describe('countIncomplete', () => {
  it('counts what the server would refuse', () => {
    expect(countIncomplete([ONE])).toBe(0)
    expect(countIncomplete([{ property: '', operator: '=', value: '' } as never])).toBe(1)
  })
})

describe('whereFromStored', () => {
  it('applies the same structural filter a URL gets', () => {
    expect(whereFromStored([ONE, 1 as never])).toEqual([ONE])
  })
})
