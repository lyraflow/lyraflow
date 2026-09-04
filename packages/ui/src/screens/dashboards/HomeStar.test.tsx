import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HomeStar } from './HomeStar.js'

/** The star's fill is the ONLY thing that says which state it is in, and it
 *  is an attribute rather than text -- lucide draws an outline by default
 *  (`fill="none"`) and the filled variant overrides it. Reading it off the
 *  rendered `<svg>` is the closest a jsdom test gets to "is it filled".
 *  It cannot see that the icon looks filled, only that the attribute the
 *  renderer needs is the one that was set. */
function starFill(button: HTMLElement): string | null {
  return button.querySelector('svg')?.getAttribute('fill') ?? null
}

describe('HomeStar', () => {
  it('names itself as the action when the dashboard is not home, and is unpressed', () => {
    render(<HomeStar isHome={false} onToggle={() => {}} />)
    const button = screen.getByRole('button', { name: 'Set as home dashboard' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(starFill(button)).toBe('none')
  })

  it('names itself as the state when the dashboard is home, and is pressed', () => {
    render(<HomeStar isHome onToggle={() => {}} />)
    const button = screen.getByRole('button', { name: 'Home dashboard — click to unset' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(starFill(button)).toBe('currentColor')
  })

  // A list renders one of these per row, so "Set as home dashboard" alone
  // would be ambiguous to anything reading the buttons out in order.
  it('names the dashboard when given one, in both states', () => {
    const { unmount } = render(<HomeStar isHome={false} name="Overview" onToggle={() => {}} />)
    expect(
      screen.getByRole('button', { name: 'Set "Overview" as home dashboard' }),
    ).toBeInTheDocument()
    unmount()

    render(<HomeStar isHome name="Overview" onToggle={() => {}} />)
    expect(
      screen.getByRole('button', { name: '"Overview" is the home dashboard — click to unset' }),
    ).toBeInTheDocument()
  })

  it('calls onToggle when clicked', async () => {
    const onToggle = vi.fn()
    render(<HomeStar isHome={false} onToggle={onToggle} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('does not call onToggle while disabled', async () => {
    const onToggle = vi.fn()
    render(<HomeStar isHome={false} onToggle={onToggle} disabled />)
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    await userEvent.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
