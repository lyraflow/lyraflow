import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { NativeSelect } from './NativeSelect.js'

describe('NativeSelect', () => {
  // THE constraint of the whole change. 87 `selectOptions` calls across 25
  // existing test files only drive a real <select>; the moment this renders
  // anything else, the suite that guards every dropdown in the product stops
  // testing the dropdowns.
  it('is a real select that userEvent.selectOptions can drive', async () => {
    const onChange = vi.fn()
    render(
      <NativeSelect aria-label="Range" defaultValue="7d" onChange={onChange}>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </NativeSelect>,
    )
    const select = screen.getByLabelText('Range')
    expect(select.tagName).toBe('SELECT')
    await userEvent.selectOptions(select, '30d')
    expect(onChange).toHaveBeenCalled()
    expect((select as HTMLSelectElement).value).toBe('30d')
  })

  // `<optgroup>` is why AddTilePicker and OperatorSelect stayed native at all
  // -- Radix would need SelectGroup/SelectLabel and a rewrite of both. Fix
  // round 2: `[&>option]` compiles to `select > option`, which never matches
  // an option nested inside an `<optgroup>` -- exactly the shape both of those
  // call sites use, so the dark-mode fix this task exists to deliver would
  // never have reached them. `[&_option]` (descendant, not child) does. This
  // pins both halves: the structure survives the component, and the selector
  // is the descendant form. Verified to fail against `[&>option]:bg-popover`
  // (see the fix-round-2 report section).
  it('reaches an option nested inside an optgroup with the descendant selector', () => {
    render(
      <NativeSelect aria-label="Operator" defaultValue="eq">
        <optgroup label="Comparison">
          <option value="eq">is</option>
        </optgroup>
      </NativeSelect>,
    )
    const select = screen.getByLabelText('Operator')
    const option = select.querySelector('option')
    expect(option).not.toBeNull()
    expect(select.contains(option)).toBe(true)
    expect(select).toHaveClass('[&_option]:bg-popover')
    expect(select).not.toHaveClass('[&>option]:bg-popover')
  })

  it('forwards id, disabled and data attributes to the select itself', () => {
    render(
      <NativeSelect id="feed-range" data-testid="feed-range" disabled defaultValue="a">
        <option value="a">A</option>
      </NativeSelect>,
    )
    const select = screen.getByTestId('feed-range')
    expect(select.tagName).toBe('SELECT')
    expect(select).toBeDisabled()
    expect(select).toHaveAttribute('id', 'feed-range')
  })

  // The two class slots reach different elements. Call sites that used to
  // size the select itself (`min-w-0` on AddTilePicker's copy) have to be
  // able to size the WRAPPER instead, because the wrapper is now the flex
  // child -- getting this backwards is how a control collapses in a row.
  it('puts className on the select and containerClassName on the wrapper', () => {
    render(
      <NativeSelect
        aria-label="Split by"
        className="test-select-class"
        containerClassName="test-wrapper-class"
        defaultValue="a"
      >
        <option value="a">A</option>
      </NativeSelect>,
    )
    const select = screen.getByLabelText('Split by')
    expect(select).toHaveClass('test-select-class')
    expect(select).not.toHaveClass('test-wrapper-class')
    expect(select.parentElement).toHaveClass('test-wrapper-class')
  })

  // The chevron is decoration over a control that already has an accessible
  // name. If it reaches the accessibility tree it becomes a second thing in
  // the label, and if it takes pointer events it eats the click that should
  // open the list.
  it('draws a decorative chevron that is hidden and takes no pointer events', () => {
    const { container } = render(
      <NativeSelect aria-label="Range" defaultValue="a">
        <option value="a">A</option>
      </NativeSelect>,
    )
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveClass('pointer-events-none')
  })

  // `appearance-none` is the ONE class that makes this look different from
  // what it replaces. Everything else in the string was already on all 19
  // call sites; without this the browser keeps painting its own arrow and
  // fill on top and the whole task changes nothing visible.
  it('suppresses the native control chrome', () => {
    render(
      <NativeSelect aria-label="Range" defaultValue="a">
        <option value="a">A</option>
      </NativeSelect>,
    )
    expect(screen.getByLabelText('Range')).toHaveClass('appearance-none')
  })
})
