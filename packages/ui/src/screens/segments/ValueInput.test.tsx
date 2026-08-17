import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ValueInput } from './ValueInput.js'

describe('ValueInput', () => {
  it('renders two value inputs for between and one for every other operator', async () => {
    const { rerender } = render(<ValueInput operator="=" value="a" onChange={vi.fn()} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    rerender(<ValueInput operator="between" value={['a', 'b']} onChange={vi.fn()} />)
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
  })

  it('does not strand a second value when switching away from between', async () => {
    // The AST refuses a non-between operator with a tuple. Leaving the
    // second value in state produces a tree the server rejects with a
    // field error the form already knew about.
    const onChange = vi.fn()
    render(<ValueInput operator="=" value={['a', 'b'] as never} onChange={onChange} />)
    expect(onChange).toHaveBeenCalledWith('a')
  })

  // --- Mutations invented beyond the tests above --------------------------

  it('expands a lone scalar into a two-slot tuple when switching TO between', () => {
    // The mirror image of the given "does not strand a second value" test:
    // a form's operator-select handler is expected to change `operator`
    // alone and leave `value` untouched in EITHER direction, not just when
    // leaving `between`. Without this, switching an existing `= 'a'`
    // condition to `between` would render a single input bound to a
    // non-array value, or crash indexing `value[0]`/`value[1]`.
    const onChange = vi.fn()
    render(<ValueInput operator="between" value="a" onChange={onChange} />)
    expect(onChange).toHaveBeenCalledWith(['a', ''])
  })

  it('does not call onChange when operator and value shape already agree', () => {
    // A stub that always "corrects" the value (e.g. always fires onChange
    // once on mount regardless of whether anything is actually wrong)
    // would pass the two tests above just as well as a real self-healing
    // effect. This is the case that catches that: nothing here is
    // mismatched, so nothing should fire.
    const onChange = vi.fn()
    render(<ValueInput operator="=" value="a" onChange={onChange} />)
    expect(onChange).not.toHaveBeenCalled()
    const onChangeBetween = vi.fn()
    render(<ValueInput operator="between" value={['a', 'b']} onChange={onChangeBetween} />)
    expect(onChangeBetween).not.toHaveBeenCalled()
  })

  it('edits only the slot the user typed into, leaving the other value alone', async () => {
    // A value fixture where both slots are the same string would not catch
    // a form that writes the first slot's edit into the second, or vice
    // versa -- distinct values in each slot make that class of bug visible.
    const onChange = vi.fn()
    render(<ValueInput operator="between" value={['start', 'finish']} onChange={onChange} />)
    const [first, second] = screen.getAllByRole('textbox')
    if (!first || !second) throw new Error('expected two value inputs')
    await userEvent.type(second, '!')
    expect(onChange).toHaveBeenLastCalledWith(['start', 'finish!'])
  })

  it('labels the two between inputs distinctly, not both "Value"', () => {
    // Two inputs sharing one accessible name are indistinguishable to
    // assistive tech and to `getByRole` alike -- this is what lets a test
    // (or a screen reader) address "the first value" separately from "the
    // second".
    render(<ValueInput operator="between" value={['a', 'b']} onChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('a')
    expect(screen.getByRole('textbox', { name: 'Value 2' })).toHaveValue('b')
  })

  it('passes a datetime-local type through so the control is a picker, not free text', () => {
    // Lifecycle values must parse as datetimes; `LifecycleForm` relies on
    // this prop actually reaching the rendered <input>, not just being
    // accepted and ignored. `input[type=datetime-local]` has no reliable
    // ARIA role mapping in jsdom, so this reaches into the DOM directly
    // rather than going through `getByRole`.
    const { container } = render(
      <ValueInput operator="=" value="2026-08-16T00:00" onChange={vi.fn()} type="datetime-local" />,
    )
    const input = container.querySelector('input[aria-label="Value"]')
    expect(input).toHaveAttribute('type', 'datetime-local')
  })

  it('renders an empty string for a null value rather than the literal text "null"', () => {
    render(<ValueInput operator="=" value={null} onChange={vi.fn()} />)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })

  // --- Suggestions, and the callers that want none -------------------------

  // Three of this component's five callers pass no `suggest`, and must be
  // untouched by the one that does. `list` is what turns an input into a
  // combobox to the accessibility tree, so an unconditional datalist would
  // silently re-label every value box in the builder as a field that offers
  // choices it does not have.
  it('stays a plain text box, with no list, when no suggestions are offered', () => {
    render(<ValueInput operator="=" value="a" onChange={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Value' })
    expect(box).not.toHaveAttribute('list')
    expect(document.querySelector('datalist')).toBeNull()
  })

  it('reports focus and every keystroke to the caller that offers suggestions', async () => {
    // Both, not just typing: focusing an empty box is the interaction that
    // has to produce a list, since there is nothing yet to type a prefix
    // from. `onChange` still fires as before -- suggestions are additive.
    const onInteract = vi.fn()
    const onChange = vi.fn()
    render(
      <ValueInput
        operator="="
        value=""
        onChange={onChange}
        suggest={{ options: ['free', 'pro'], onInteract }}
      />,
    )
    const box = screen.getByRole('combobox', { name: 'Value' })
    await userEvent.click(box)
    expect(onInteract).toHaveBeenCalledWith('')

    await userEvent.type(box, 'p')
    expect(onInteract).toHaveBeenLastCalledWith('p')
    expect(onChange).toHaveBeenLastCalledWith('p')
  })

  it('gives both between bounds the same list, each reporting its own text', async () => {
    const onInteract = vi.fn()
    render(
      <ValueInput
        operator="between"
        value={['a', 'b']}
        onChange={vi.fn()}
        suggest={{ options: ['free'], onInteract }}
      />,
    )
    const first = screen.getByRole('combobox', { name: 'Value 1' })
    const second = screen.getByRole('combobox', { name: 'Value 2' })
    const list = document.querySelector('datalist')?.id
    expect(list).toBeTruthy()
    expect(first).toHaveAttribute('list', list)
    expect(second).toHaveAttribute('list', list)

    // Each box reports ITS OWN text. A shared list does not mean a shared
    // prefix: seeding the upper bound's lookup with the lower bound's text
    // would filter against something nobody is editing.
    await userEvent.click(second)
    expect(onInteract).toHaveBeenLastCalledWith('b')
    await userEvent.click(first)
    expect(onInteract).toHaveBeenLastCalledWith('a')
  })
})
