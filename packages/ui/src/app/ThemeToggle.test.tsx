import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeToggle, applyTheme } from './ThemeToggle.js'

// THREE states, not two. An absent `data-theme` is "follow the system" and
// is the default -- the state an implementation naturally forgets to test,
// because it looks like "nothing happened" rather than a state of its own.
describe('theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  it('applyTheme("system") leaves data-theme absent', () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('applyTheme("dark") sets data-theme="dark"', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('a fresh mount with nothing stored leaves data-theme absent', () => {
    render(<ThemeToggle />)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  // Invented: nothing above ever clicks the control. A no-op onClick would
  // leave every assertion above green, since they all drive state through
  // applyTheme() directly or via a fresh, unclicked mount.
  it('clicking the control cycles system -> light -> dark -> system', async () => {
    render(<ThemeToggle />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('system')

    await userEvent.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(button).toHaveTextContent('light')

    await userEvent.click(button)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(button).toHaveTextContent('dark')

    await userEvent.click(button)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(button).toHaveTextContent('system')
  })

  // Invented: every other test lives entirely within one mount. Dropping
  // the localStorage read/write in the effect would still leave all of them
  // green -- the gap only shows up across a remount, which is what an
  // actual page load is.
  it('persists an explicit choice across a remount', async () => {
    const { unmount } = render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button')) // system -> light
    unmount()

    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveTextContent('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})
