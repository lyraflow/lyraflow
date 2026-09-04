import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppearanceSection } from './AppearanceSection.js'

const root = () => document.documentElement

describe('AppearanceSection', () => {
  beforeEach(() => {
    root().removeAttribute('data-palette')
    localStorage.clear()
  })
  afterEach(() => {
    root().removeAttribute('data-palette')
    localStorage.clear()
  })

  it('offers seven palettes as one radio group with copper checked by default', () => {
    render(<AppearanceSection />)
    expect(screen.getByRole('group', { name: /accent colour/i })).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([
      'copper',
      'cobalt',
      'moss',
      'plum',
      'slate',
      'wine',
      'amber',
    ])
    expect(screen.getByRole('radio', { name: 'Copper' })).toBeChecked()
  })

  it('reflects a stored choice on mount', () => {
    localStorage.setItem('lf-palette', 'plum')
    render(<AppearanceSection />)
    expect(screen.getByRole('radio', { name: 'Plum' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Copper' })).not.toBeChecked()
  })

  it('choosing Cobalt applies it immediately and stores it', async () => {
    render(<AppearanceSection />)
    await userEvent.click(screen.getByRole('radio', { name: 'Cobalt' }))
    expect(root().getAttribute('data-palette')).toBe('cobalt')
    expect(localStorage.getItem('lf-palette')).toBe('cobalt')
    expect(screen.getByRole('radio', { name: 'Cobalt' })).toBeChecked()
  })

  it('choosing Copper removes both the attribute and the key', async () => {
    localStorage.setItem('lf-palette', 'wine')
    root().setAttribute('data-palette', 'wine')
    render(<AppearanceSection />)
    await userEvent.click(screen.getByRole('radio', { name: 'Copper' }))
    expect(root().hasAttribute('data-palette')).toBe(false)
    expect(localStorage.getItem('lf-palette')).toBeNull()
  })

  it('all seven radios share one name, so the browser gives them arrow-key movement', () => {
    render(<AppearanceSection />)
    const names = new Set(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).name))
    expect(names).toEqual(new Set(['accent-palette']))
  })

  it("each swatch is scoped to its own palette so it paints that palette's token", () => {
    render(<AppearanceSection />)
    for (const id of ['copper', 'cobalt', 'moss', 'plum', 'slate', 'wine', 'amber']) {
      const swatch = screen.getByTestId(`swatch-${id}`)
      expect(swatch).toHaveAttribute('data-palette', id)
      expect(swatch.getAttribute('style')).toContain('var(--lf-accent-500)')
    }
  })

  it('says where the choice is kept and what it changes', () => {
    render(<AppearanceSection />)
    expect(screen.getByText(/stored in this browser/i)).toBeInTheDocument()
    expect(screen.getByText(/changes the accent colour only/i)).toBeInTheDocument()
  })
})
