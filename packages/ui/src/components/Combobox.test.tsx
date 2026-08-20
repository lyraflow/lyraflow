import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Combobox } from './Combobox.js'

/** Three options, none a prefix of another, and all unlike anything typed in
 * these tests. Two would let "selects the option you clicked" pass for
 * "selects the first"; a single one would let it pass for "selects whatever
 * there is". Every selection test below clicks or arrows to the LAST. */
const OPTIONS = ['checkout_started', 'page_view', 'signup_completed']

/** Controlled the way every real caller controls it -- the text has to
 * survive between keystrokes, or typing comes out garbled for reasons that
 * have nothing to do with the component. */
function Harness(props: {
  options?: string[]
  value?: string
  onChange?: (v: string) => void
  onInteract?: (t: string) => void
  disabled?: boolean
  loading?: boolean
  emptyMessage?: string
  label?: string
}) {
  const [value, setValue] = useState(props.value ?? '')
  return (
    <Combobox
      label={props.label ?? 'Event'}
      value={value}
      options={props.options ?? OPTIONS}
      disabled={props.disabled}
      loading={props.loading}
      emptyMessage={props.emptyMessage}
      onInteract={props.onInteract}
      onChange={(v) => {
        setValue(v)
        props.onChange?.(v)
      }}
    />
  )
}

const field = () => screen.getByRole('combobox', { name: 'Event' })
const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent)

describe('Combobox -- the list is there before you know what to type', () => {
  // THE point of this component, and the reason a native `<datalist>` could
  // not stay: a browser decides for itself when to open one, so "show me
  // everything the moment I focus" was unreachable. The assertion is on the
  // OPTIONS, not on `aria-expanded`: a popup that reports itself open while
  // rendering nothing would satisfy the attribute and help nobody.
  it('opens on focus and shows the whole list, with nothing typed', async () => {
    render(<Harness />)
    expect(screen.queryByRole('listbox')).toBeNull()

    // Focus arriving on its own, by keyboard -- NOT a click. A click would
    // also reach the click handler that exists for the Escape case, so a
    // click-driven test cannot tell "opens on focus" from "opens on click".
    await userEvent.tab()
    expect(field()).toHaveFocus()

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(optionNames()).toEqual(OPTIONS)
  })

  it('reports itself expanded while the popup is open', async () => {
    render(<Harness />)
    await userEvent.click(field())
    expect(field()).toHaveAttribute('aria-expanded', 'true')
  })

  it('is closed, and says so, before it is focused', () => {
    render(<Harness />)
    expect(field()).toHaveAttribute('aria-expanded', 'false')
    expect(field()).not.toHaveAttribute('aria-controls')
    expect(optionNames()).toEqual([])
  })

  it('tells the caller it was opened, with the text already in the box', async () => {
    // The hook a caller whose lookup is on-demand hangs its fetch on. The
    // text matters as much as the call: a lookup seeded with the wrong box's
    // text prefix-filters against something nobody is editing.
    const onInteract = vi.fn()
    render(<Harness value="pa" onInteract={onInteract} />)
    await userEvent.click(field())
    expect(onInteract).toHaveBeenCalledWith('pa')
  })

  it('does not open when disabled', async () => {
    render(<Harness disabled />)
    await userEvent.click(field())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field()).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('Combobox -- the list is a help, never a whitelist', () => {
  it('keeps a typed name the list has never heard of', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'not_yet_fired')
    expect(onChange).toHaveBeenLastCalledWith('not_yet_fired')
    expect(field()).toHaveValue('not_yet_fired')
  })

  // Filtering is a server-side prefix lookup owned by the caller. If this
  // component narrowed the list as well, a second and different rule would
  // silently apply on top of one that has already run -- and the caller's
  // debounce would be pointless. The typed text here matches NO option, so a
  // component that filtered would show an empty list.
  it('renders what it was given, verbatim, however little it matches the text', async () => {
    render(<Harness />)
    await userEvent.type(field(), 'zzz')
    expect(optionNames()).toEqual(OPTIONS)
  })

  it('reports every keystroke to the caller so the lookup can narrow', async () => {
    const onInteract = vi.fn()
    render(<Harness onInteract={onInteract} />)
    await userEvent.type(field(), 'pa')
    expect(onInteract).toHaveBeenLastCalledWith('pa')
  })
})

describe('Combobox -- choosing', () => {
  it('takes the option that was clicked, not the first one', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(field())
    await userEvent.click(screen.getByRole('option', { name: 'signup_completed' }))
    expect(onChange).toHaveBeenLastCalledWith('signup_completed')
    expect(field()).toHaveValue('signup_completed')
  })

  it('closes after a click, and leaves focus where the operator can keep typing', async () => {
    render(<Harness />)
    await userEvent.click(field())
    await userEvent.click(screen.getByRole('option', { name: 'page_view' }))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field()).toHaveFocus()
  })

  it('walks the list with the arrows and marks exactly one option active', async () => {
    render(<Harness />)
    await userEvent.click(field())
    // Nothing is active on open -- see the Enter test below for why.
    expect(field()).not.toHaveAttribute('aria-activedescendant')

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    const active = screen.getByRole('option', { name: 'signup_completed' })
    expect(field()).toHaveAttribute('aria-activedescendant', active.id)
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.queryAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1)
  })

  it('walks upwards too, wrapping to the end of the list', async () => {
    render(<Harness />)
    await userEvent.click(field())
    await userEvent.keyboard('{ArrowUp}')
    expect(field()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'signup_completed' }).id,
    )
  })

  it('takes the active option on Enter -- the third, not the first', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(field())
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('signup_completed')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // An operator who focuses a field and presses Enter is submitting, not
  // choosing. A picker that quietly rewrites their text for that is worse
  // than one that never opened -- so an open popup with no active row must
  // let Enter through untouched.
  it('does not choose anything on Enter when no option is active', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'my_own_name')
    onChange.mockClear()
    await userEvent.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(field()).toHaveValue('my_own_name')
  })

  it('opens with the row already in the box active, so Enter re-picks it', async () => {
    render(<Harness value="page_view" />)
    await userEvent.click(field())
    expect(field()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'page_view' }).id,
    )
  })
})

describe('Combobox -- getting out', () => {
  it('closes on Escape and keeps what was typed', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'page')
    await userEvent.keyboard('{ArrowDown}')
    onChange.mockClear()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field()).toHaveValue('page')
    // Escape abandons the list, not the text: it must not commit the row
    // that happened to be highlighted.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes on Tab and keeps what was typed', async () => {
    const onChange = vi.fn()
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">next</button>
      </>,
    )
    await userEvent.type(field(), 'page')
    await userEvent.keyboard('{ArrowDown}')
    onChange.mockClear()

    await userEvent.tab()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(field()).toHaveValue('page')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'next' })).toHaveFocus()
  })

  it('closes when the operator clicks somewhere else entirely', async () => {
    render(
      <>
        <Harness />
        <p data-testid="elsewhere">elsewhere</p>
      </>,
    )
    await userEvent.click(field())
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('elsewhere'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  // The other half of the same rule, and the one a document-level
  // "click outside" listener gets wrong: the popup's own body is not
  // outside. Dragging its scrollbar, or clicking the padding between rows,
  // must not close the list -- which is what defaulting away every mousedown
  // inside it buys.
  it('stays open when the click lands inside the popup but not on a row', async () => {
    render(<Harness />)
    await userEvent.click(field())
    await userEvent.click(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(field()).toHaveFocus()
  })

  it('reopens on a click when Escape closed it without moving focus', async () => {
    // Escape leaves focus in the box, so there is no second focus event to
    // reopen on -- without a click handler the field is stuck shut until the
    // operator tabs away and back.
    render(<Harness />)
    await userEvent.click(field())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()

    await userEvent.click(field())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})

describe('Combobox -- an empty list says why', () => {
  it('does not assert an absence while the first lookup is still out', async () => {
    render(<Harness options={[]} loading emptyMessage="No events recorded yet." />)
    await userEvent.click(field())
    expect(screen.getByRole('listbox')).toHaveTextContent(/looking/i)
    expect(screen.queryByText(/no events recorded yet/i)).not.toBeInTheDocument()
  })

  it("says the caller's own reason once a lookup has answered with nothing", async () => {
    render(<Harness options={[]} emptyMessage="No events recorded yet." />)
    await userEvent.click(field())
    expect(screen.getByText(/no events recorded yet/i)).toBeInTheDocument()
  })

  // A different empty from the one above, and it must not borrow that
  // message: names DO exist, none of them start with this. Saying "none
  // recorded" here would teach the operator their events are missing when
  // the truth is only that the server matches on a prefix.
  it('blames the prefix, not the project, when text has been typed', async () => {
    render(<Harness options={[]} emptyMessage="No events recorded yet." />)
    await userEvent.type(field(), 'zzz')
    expect(screen.getByRole('listbox')).toHaveTextContent(/zzz/)
    expect(screen.queryByText(/no events recorded yet/i)).not.toBeInTheDocument()
  })
})

describe('Combobox -- the popup escapes every scroll container above it', () => {
  // The trap this component exists to avoid: the app shell puts
  // `<main class="overflow-auto">` inside a fixed-height page, and a
  // condition row sits several bordered cards deep inside it. Rendered in
  // normal flow, the popup is clipped by the first of those; a portal to
  // <body> plus `position: fixed` is what makes an ancestor's overflow
  // irrelevant. jsdom paints nothing, so what is checked here is the
  // MECHANISM -- where the node lives and how it is positioned -- and the
  // rasterised screenshots check the result.
  it('renders outside the field, as a direct child of the document body', async () => {
    render(
      <div data-testid="clipper" style={{ overflow: 'auto', height: '20px' }}>
        <Harness />
      </div>,
    )
    await userEvent.click(field())
    const list = screen.getByRole('listbox')
    expect(list.parentElement).toBe(document.body)
    expect(screen.getByTestId('clipper').contains(list)).toBe(false)
  })

  it('is positioned against the viewport, not against whatever contains it', async () => {
    render(<Harness />)
    await userEvent.click(field())
    expect(screen.getByRole('listbox')).toHaveStyle({ position: 'fixed' })
  })
})

describe('Combobox -- placement arithmetic', () => {
  // jsdom has no layout at all, so the field's box is stubbed. This is the
  // only way to exercise the flip and the edge clamp as arithmetic; the
  // rasterised screenshots are what prove the arithmetic was the right one.
  const VIEWPORT_H = window.innerHeight
  const VIEWPORT_W = window.innerWidth

  function stubFieldBox(box: { top: number; bottom: number; left: number; width: number }) {
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.slot === 'input' || this.querySelector('[data-slot="input"]') !== null) {
        return {
          ...box,
          right: box.left + box.width,
          height: box.bottom - box.top,
          x: box.left,
          y: box.top,
          toJSON: () => ({}),
        } as DOMRect
      }
      return original.call(this)
    })
  }

  afterEach(() => vi.restoreAllMocks())

  it('opens downwards when there is room below', async () => {
    stubFieldBox({ top: 100, bottom: 136, left: 40, width: 300 })
    render(<Harness />)
    await userEvent.click(field())
    const list = screen.getByRole('listbox')
    expect(list.style.top).toBe('140px')
    expect(list.style.bottom).toBe('')
  })

  // The case the brief singles out: a condition near the bottom of a long
  // tree. Opening downwards there puts the list off the screen entirely.
  it('flips upwards when the field is near the bottom of the viewport', async () => {
    stubFieldBox({ top: VIEWPORT_H - 60, bottom: VIEWPORT_H - 24, left: 40, width: 300 })
    render(<Harness />)
    await userEvent.click(field())
    const list = screen.getByRole('listbox')
    expect(list.style.bottom).toBe(`${VIEWPORT_H - (VIEWPORT_H - 60) + 4}px`)
    expect(list.style.top).toBe('')
  })

  it('never hangs off the right edge, however narrow the field is', async () => {
    // A `between` bound at the far right: widened to a readable minimum, it
    // would otherwise start at the field's own left and run past the
    // viewport -- which is horizontal page scroll, the exact failure the
    // narrow-viewport checks exist to catch.
    stubFieldBox({ top: 100, bottom: 136, left: VIEWPORT_W - 44, width: 40 })
    render(<Harness />)
    await userEvent.click(field())
    const list = screen.getByRole('listbox')
    const left = Number.parseFloat(list.style.left)
    const width = Number.parseFloat(list.style.width)
    expect(width).toBeGreaterThanOrEqual(200)
    expect(left + width).toBeLessThanOrEqual(VIEWPORT_W)
  })

  it('follows the field when an ancestor scrolls, rather than staying behind', async () => {
    stubFieldBox({ top: 300, bottom: 336, left: 40, width: 300 })
    render(<Harness />)
    await userEvent.click(field())
    expect(screen.getByRole('listbox').style.top).toBe('340px')

    // Scroll does not bubble, so the listener has to be a capturing one --
    // the element that actually scrolls in the app is `main`, not `window`.
    stubFieldBox({ top: 120, bottom: 156, left: 40, width: 300 })
    act(() => {
      document.body.dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    await waitFor(() => expect(screen.getByRole('listbox').style.top).toBe('160px'))
  })
})

describe('Combobox -- the accessible tree the rest of the app queries', () => {
  // Every existing field in this builder is reached by
  // `getByRole('combobox', { name: … })`, because an `<input list=…>`
  // computes exactly that role. Replacing the datalist must not have changed
  // it, for the tests and for a screen reader alike.
  it('keeps the combobox role and the field name the datalist gave it', () => {
    render(<Harness label="Trait" />)
    expect(screen.getByRole('combobox', { name: 'Trait' })).toBeInTheDocument()
  })

  it('points aria-controls at the popup while it is open, and drops it when closed', async () => {
    render(<Harness />)
    await userEvent.click(field())
    expect(field()).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)

    await userEvent.keyboard('{Escape}')
    expect(field()).not.toHaveAttribute('aria-controls')
  })

  // A shorter answer arriving while a later row was highlighted would
  // otherwise leave `aria-activedescendant` naming an id that no longer
  // exists -- which a screen reader announces as nothing at all.
  it('never names an option that is no longer in the list', async () => {
    function Shrinking() {
      const [options, setOptions] = useState(OPTIONS)
      return (
        <>
          <Combobox label="Event" value="" options={options} onChange={() => {}} />
          {/* `preventDefault` on mousedown so the field keeps focus and the
           * popup stays open: without it the click blurs the input, the
           * popup unmounts, `aria-activedescendant` disappears for that
           * reason alone, and the assertion below passes against a stale
           * highlight it never got to see. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOptions(['checkout_started'])}
          >
            answer
          </button>
        </>
      )
    }
    render(<Shrinking />)
    await userEvent.click(field())
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(field()).toHaveAttribute('aria-activedescendant')

    await userEvent.click(screen.getByRole('button', { name: 'answer' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    const named = field().getAttribute('aria-activedescendant')
    expect(named).not.toBeNull()
    expect(document.getElementById(named as string)).not.toBeNull()
  })

  it('does not put a second element carrying the field name into the tree', async () => {
    // The popup is reached through the combobox, which already carries the
    // name. Naming it "<field> suggestions" made every accessible-name query
    // for the field itself ambiguous the moment it opened.
    render(<Harness label="Event" />)
    await userEvent.click(field())
    expect(screen.getAllByLabelText(/event/i)).toHaveLength(1)
  })
})

describe('Combobox — sectioned options', () => {
  /** Same shape `FieldCombobox` passes: two sections, and one name present
   * in BOTH, which is the case the whole `group` argument exists for. */
  const GROUPS = [
    { label: 'Attributes', options: ['path', 'utm_campaign'] },
    { label: 'Properties', options: ['path', 'plan'] },
  ]

  function Sectioned(props: { onChange?: (v: string, g?: string) => void }) {
    const [value, setValue] = useState('')
    return (
      <Combobox
        label="Field"
        value={value}
        options={[]}
        groups={GROUPS}
        onChange={(v, g) => {
          setValue(v)
          props.onChange?.(v, g)
        }}
      />
    )
  }

  it('shows each section under its own heading', async () => {
    render(<Sectioned />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Field' }))
    expect(screen.getByText('Attributes')).toBeInTheDocument()
    expect(screen.getByText('Properties')).toBeInTheDocument()
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'path',
      'utm_campaign',
      'path',
      'plan',
    ])
  })

  // A heading is not an option. If it were reachable as one, Enter on it
  // would commit the section's own name as the field, and
  // `aria-activedescendant` would name something a screen reader announces
  // as nothing.
  it('walks options only, skipping the headings', async () => {
    render(<Sectioned />)
    const box = screen.getByRole('combobox', { name: 'Field' })
    await userEvent.click(box)
    for (const expected of ['path', 'utm_campaign', 'path', 'plan']) {
      await userEvent.keyboard('{ArrowDown}')
      const active = screen
        .getAllByRole('option')
        .find((o) => o.getAttribute('aria-selected') === 'true')
      expect(active?.textContent).toBe(expected)
    }
    // And wraps back to the first option rather than onto a heading.
    await userEvent.keyboard('{ArrowDown}')
    const active = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true')
    expect(active?.textContent).toBe('path')
  })

  // The reason this prop exists at all. Both sections offer `path`; which
  // one was chosen is a fact only this component holds, and without it the
  // caller cannot tell an event column from a property of the same name.
  it('reports which section a chosen row came from', async () => {
    const onChange = vi.fn()
    render(<Sectioned onChange={onChange} />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Field' }))
    await userEvent.click(screen.getAllByRole('option', { name: 'path' })[1] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith('path', 'Properties')

    await userEvent.click(screen.getByRole('combobox', { name: 'Field' }))
    await userEvent.click(screen.getAllByRole('option', { name: 'path' })[0] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith('path', 'Attributes')
  })

  it('reports the section when a row is chosen by keyboard too', async () => {
    const onChange = vi.fn()
    render(<Sectioned onChange={onChange} />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Field' }))
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('utm_campaign', 'Attributes')
  })

  // Typed text belongs to no section, and the caller reads that as "this is
  // free text" -- the difference between choosing an attribute and typing
  // its name.
  it('passes no section for text the operator typed', async () => {
    const onChange = vi.fn()
    render(<Sectioned onChange={onChange} />)
    await userEvent.type(screen.getByRole('combobox', { name: 'Field' }), 'pa')
    // On the arguments, not on the call shape: this harness forwards both
    // of them, so what matters is that the second one is undefined.
    expect(onChange.mock.lastCall?.[0]).toBe('pa')
    expect(onChange.mock.lastCall?.[1]).toBeUndefined()
  })
})
