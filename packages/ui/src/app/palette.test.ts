import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE,
  PALETTES,
  PALETTE_KEY,
  applyPalette,
  isPaletteId,
  readStoredPalette,
  storePalette,
} from './palette.js'

const root = () => document.documentElement

describe('palette model', () => {
  beforeEach(() => {
    root().removeAttribute('data-palette')
    localStorage.clear()
  })
  afterEach(() => {
    root().removeAttribute('data-palette')
    localStorage.clear()
  })

  it('copper is first and is the default', () => {
    expect(PALETTES[0]?.id).toBe('copper')
    expect(DEFAULT_PALETTE).toBe('copper')
    expect(PALETTES.map((p) => p.id)).toEqual([
      'copper',
      'cobalt',
      'moss',
      'plum',
      'slate',
      'wine',
      'amber',
    ])
  })

  it('applyPalette(copper) leaves data-palette absent, even if it was set', () => {
    root().setAttribute('data-palette', 'moss')
    applyPalette('copper')
    expect(root().hasAttribute('data-palette')).toBe(false)
  })

  it('applyPalette(cobalt) sets data-palette="cobalt"', () => {
    applyPalette('cobalt')
    expect(root().getAttribute('data-palette')).toBe('cobalt')
  })

  it('readStoredPalette is copper for a missing key', () => {
    expect(readStoredPalette()).toBe('copper')
  })

  it('readStoredPalette is copper for an unknown value, not the raw string', () => {
    localStorage.setItem(PALETTE_KEY, 'chartreuse')
    expect(readStoredPalette()).toBe('copper')
  })

  it('readStoredPalette returns a stored known palette', () => {
    localStorage.setItem(PALETTE_KEY, 'wine')
    expect(readStoredPalette()).toBe('wine')
  })

  it('storePalette(copper) REMOVES the key rather than storing the word', () => {
    localStorage.setItem(PALETTE_KEY, 'plum')
    storePalette('copper')
    expect(localStorage.getItem(PALETTE_KEY)).toBeNull()
  })

  it('storePalette writes any other id', () => {
    storePalette('slate')
    expect(localStorage.getItem(PALETTE_KEY)).toBe('slate')
  })

  it('isPaletteId accepts the seven ids and nothing else', () => {
    for (const p of PALETTES) expect(isPaletteId(p.id)).toBe(true)
    expect(isPaletteId('teal')).toBe(false)
    expect(isPaletteId(undefined)).toBe(false)
    expect(isPaletteId(3)).toBe(false)
  })
})
