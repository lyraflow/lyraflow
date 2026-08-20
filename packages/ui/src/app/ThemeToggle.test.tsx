import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeToggle, applyTheme } from './ThemeToggle.js'

/**
 * jsdom implements no `matchMedia`, so every test that cares what the
 * operating system is asking for has to say. `undefined` is its own case and
 * is covered below -- the component must render in an environment that has
 * no such API at all.
 */
function stubSystem(prefersDark: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: prefersDark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  )
  return {
    /** The operator changes their machine's theme with the page open. */
    change(next: boolean) {
      query.matches = next
      for (const fn of listeners) fn()
    },
  }
}

// THREE states, still, and the third is still the default -- but only two are
// reachable from the control. An absent `data-theme` is "follow the system",
// and it is the state an implementation forgets to test because it looks
// like "nothing happened" rather than a state of its own.
describe('theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
    vi.unstubAllGlobals()
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

  // The whole reason the control lost its third state without the MODEL
  // losing it: a first visit must not overrule the machine it is on. If this
  // mount wrote anything, a dark-mode visitor would get a light page and no
  // way to know why.
  it('writes nothing on a fresh mount, so the system preference still decides', () => {
    stubSystem(true)
    render(<ThemeToggle />)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem('lf-theme')).toBeNull()
  })

  it('renders in an environment with no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<ThemeToggle />)
    // Falls back to light, so the offer is to switch to dark.
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  // The icon names the ACTION. On a dark page the offer is light, and
  // vice versa -- a control that offered the mode already on screen would be
  // the one bug nobody reports and everybody notices.
  it('offers the mode the page is not in', () => {
    stubSystem(true)
    const { unmount } = render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
    unmount()

    stubSystem(false)
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  it('clicking applies the offered theme and stores it', async () => {
    stubSystem(false)
    render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('lf-theme')).toBe('dark')
    // And now offers the way back, rather than a third state.
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })

  it('flips back and forth between exactly two states', async () => {
    stubSystem(false)
    render(<ThemeToggle />)
    const click = async () => userEvent.click(screen.getByRole('button'))
    await click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    await click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    // Never back to absent: "system" is no longer reachable by clicking,
    // which is the whole of what was asked for.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(true)
  })

  // Every other test lives within one mount. Dropping the localStorage
  // read/write would leave them green -- the gap only shows across a
  // remount, which is what a page load is.
  it('persists an explicit choice across a remount', async () => {
    stubSystem(false)
    const { unmount } = render(<ThemeToggle />)
    await userEvent.click(screen.getByRole('button'))
    unmount()

    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })

  // A stored choice outranks the machine. Without this an operator who
  // deliberately picked light on a dark laptop would be overruled by their
  // own OS on the next page load.
  it('lets a stored choice win over the system preference', () => {
    stubSystem(true)
    localStorage.setItem('lf-theme', 'light')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
  })

  // "Follow the system" has to keep following it, including while the page
  // is open -- the CSS already does, and this keeps the ICON from offering
  // the mode already on screen.
  it('tracks an OS change mid-session while nothing is stored', async () => {
    const system = stubSystem(false)
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument()
    await userEvent.click(document.body) // no-op; just settle the render
    system.change(true)
    expect(await screen.findByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument()
  })
})
