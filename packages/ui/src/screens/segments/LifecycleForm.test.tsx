import { Lifecycle as LifecycleSchema } from '@lyraflow/core/segments/ast.js'
import type { Lifecycle } from '@lyraflow/core/segments/ast.js'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LifecycleForm } from './LifecycleForm.js'

const lifecycleNode = (): Lifecycle => ({
  kind: 'lifecycle',
  field: 'first_seen',
  operator: '>=',
  value: '2026-01-01T00:00',
})

/**
 * **Every conversion assertion below is meaningless in UTC**, which is the
 * coincidence point that hid the defect these tests exist for: where local IS
 * UTC, an identity function and a correct conversion agree on every fixture,
 * and every fixture this file used to carry was zone-less as well -- the one
 * shape an unconverted read renders correctly. So the zone is pinned, the same
 * way and for the same reason `datetime.test.ts` pins it, and the pin is
 * asserted rather than assumed.
 *
 * `+05:30`: neither zero nor a whole number of hours, so a conversion that
 * drops the minutes fails as well as one that drops the offset. `10:00` local
 * is `04:30` UTC -- a different hour AND minute -- and `02:00` local is
 * `20:30` UTC on the PREVIOUS day of the PREVIOUS month, so a conversion that
 * gets the clock right and the date wrong cannot pass either.
 */
const ZONE = 'Asia/Kolkata'
const LOCAL_MIDMORNING = '2026-08-01T10:00'
const INSTANT_MIDMORNING = '2026-08-01T04:30:00.000Z'
const LOCAL_EARLY = '2026-08-01T02:00'
const INSTANT_EARLY = '2026-07-31T20:30:00.000Z'

beforeAll(() => {
  vi.stubEnv('TZ', ZONE)
})

afterAll(() => {
  vi.unstubAllEnvs()
})

/** The value control, addressed the way `ValueInput` labels it. */
function valueBox(): HTMLInputElement {
  return screen.getByLabelText('Value') as HTMLInputElement
}

/**
 * A CONTROLLED host, because the round trip is the thing that has to hold:
 * a conversion applied on the way in and not on the way out (or the reverse)
 * is the classic shape of this defect, and only a component that re-renders
 * from what it stored can show it.
 */
function Stateful(props: { initial: Lifecycle; onNode?: (n: Lifecycle) => void }) {
  const [node, setNode] = useState(props.initial)
  return (
    <LifecycleForm
      id="c"
      node={node}
      onChange={(next) => {
        setNode(next)
        props.onNode?.(next)
      }}
    />
  )
}

describe('LifecycleForm', () => {
  it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
    // Asserted, not assumed: if the stub silently did not take, every
    // conversion test in this file would pass while proving nothing.
    expect(new Date(LOCAL_MIDMORNING).toISOString()).toBe(INSTANT_MIDMORNING)
    expect(new Date(LOCAL_MIDMORNING).getTimezoneOffset()).not.toBe(0)
  })

  it('offers exactly first_seen and last_seen as field options', () => {
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /field/i })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['first_seen', 'last_seen'])
  })

  it('renders the value control as a datetime picker, not a free text box', () => {
    // The single most concrete requirement: "Lifecycle values
    // must parse as datetimes; use a datetime control rather than a free
    // text box." A stub that rendered a plain text input with the right
    // value would pass every OTHER assertion in this file.
    const { container } = render(<LifecycleForm id="c" node={lifecycleNode()} onChange={vi.fn()} />)
    const input = container.querySelector('input[aria-label="Value"]')
    expect(input).toHaveAttribute('type', 'datetime-local')
    expect(input).toHaveValue('2026-01-01T00:00')
  })

  it('changing the field updates only field, leaving operator and value untouched', async () => {
    const onChange = vi.fn()
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /field/i }), 'last_seen')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'lifecycle',
      field: 'last_seen',
      operator: '>=',
      value: '2026-01-01T00:00',
    })
  })

  it('changing the operator updates only operator, leaving field and value untouched', async () => {
    const onChange = vi.fn()
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^operator$/i }), '<')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '<',
      value: '2026-01-01T00:00',
    })
  })

  /**
   * The three cases the stored column actually holds, plus the round trip.
   * Each is pinned on its own, because the two directions of the conversion
   * are two separate guards: removing the read conversion leaves the write
   * one green, and removing the write conversion leaves the read one green.
   */
  describe('the stored value and what the picker shows are different things', () => {
    it('shows a stored INSTANT as the local wall-clock it names, rather than as an empty box', () => {
      // The Critical, stated as the operator saw it. A `datetime-local` input
      // renders NOTHING for a `Z`-suffixed string, so every saved segment
      // carrying a lifecycle bound written by the API or the CLI opened with
      // that bound invisible -- and with no "not finished" message either,
      // because the node is perfectly valid.
      render(
        <LifecycleForm
          id="c"
          node={{ ...lifecycleNode(), value: INSTANT_MIDMORNING }}
          onChange={vi.fn()}
        />,
      )
      expect(valueBox()).toHaveValue(LOCAL_MIDMORNING)
      expect(valueBox().value).not.toBe('')
    })

    it('accepts an offset form as well as `Z`, since both name an instant', () => {
      render(
        <LifecycleForm
          id="c"
          node={{ ...lifecycleNode(), value: '2026-08-01T00:00:00-04:30' }}
          onChange={vi.fn()}
        />,
      )
      expect(valueBox()).toHaveValue(LOCAL_MIDMORNING)
    })

    it('shows a stored ZONE-LESS reading UNSHIFTED, because it names no instant to convert', () => {
      // The other side of the ruling, and load-bearing rather than tidiness:
      // `Lifecycle`'s refine accepts a zone-less reading, so such values are
      // already stored. Converting one here would move a bound nobody edited
      // by an offset nobody recorded -- five and a half hours, on this
      // fixture -- the first time its row rendered.
      render(
        <LifecycleForm
          id="c"
          node={{ ...lifecycleNode(), value: LOCAL_MIDMORNING }}
          onChange={vi.fn()}
        />,
      )
      expect(valueBox()).toHaveValue(LOCAL_MIDMORNING)
    })

    it('writes back an instant that CARRIES a zone, not the picker’s own wall-clock text', () => {
      const onNode = vi.fn()
      render(<Stateful initial={{ ...lifecycleNode(), value: INSTANT_EARLY }} onNode={onNode} />)
      fireEvent.change(valueBox(), { target: { value: LOCAL_MIDMORNING } })

      const next = onNode.mock.calls.at(-1)?.[0] as Lifecycle
      // The exact instant, so a conversion that drops the offset's minutes or
      // lands on the wrong day fails here...
      expect(next.value).toBe(INSTANT_MIDMORNING)
      // ...and separately, that it carries a zone AT ALL, which is the
      // property the ruling is about: a zone-less string is resolved by the
      // compiler in the SERVER's zone, not the operator's.
      expect(String(next.value)).toMatch(/T.*(?:Z|[+-]\d{2}:?\d{2})$/)
      // Against the real schema, never a hand-written notion of valid.
      expect(LifecycleSchema.safeParse(next).success).toBe(true)
    })

    it('round-trips: what was typed stays on screen, while what is STORED is the instant', () => {
      // Both halves in one test on purpose. A display-only round trip is
      // survivable by a conversion that is broken in both directions at once
      // -- an identity write leaves a zone-less string that the read path
      // then passes straight through, and the box looks right. So the stored
      // value is asserted here too.
      const onNode = vi.fn()
      render(<Stateful initial={{ ...lifecycleNode(), value: INSTANT_EARLY }} onNode={onNode} />)
      expect(valueBox()).toHaveValue(LOCAL_EARLY)

      fireEvent.change(valueBox(), { target: { value: LOCAL_MIDMORNING } })
      expect(valueBox()).toHaveValue(LOCAL_MIDMORNING)
      expect((onNode.mock.calls.at(-1)?.[0] as Lifecycle).value).toBe(INSTANT_MIDMORNING)
    })

    it('converts BOTH bounds under `between`, not only the first', () => {
      // `between` is where a conversion written for the scalar case alone
      // fails silently: the second bound is a second value on the same node.
      const onNode = vi.fn()
      render(
        <Stateful
          initial={{
            ...lifecycleNode(),
            operator: 'between',
            value: [INSTANT_EARLY, INSTANT_MIDMORNING],
          }}
          onNode={onNode}
        />,
      )
      expect(screen.getByLabelText('Value 1')).toHaveValue(LOCAL_EARLY)
      expect(screen.getByLabelText('Value 2')).toHaveValue(LOCAL_MIDMORNING)

      fireEvent.change(screen.getByLabelText('Value 2'), { target: { value: LOCAL_EARLY } })
      const next = onNode.mock.calls.at(-1)?.[0] as Lifecycle
      expect(next.value).toEqual([INSTANT_EARLY, INSTANT_EARLY])
    })

    it('leaves a cleared bound EMPTY rather than inventing an instant for it', () => {
      const onNode = vi.fn()
      render(
        <Stateful initial={{ ...lifecycleNode(), value: INSTANT_MIDMORNING }} onNode={onNode} />,
      )
      fireEvent.change(valueBox(), { target: { value: '' } })
      expect(valueBox()).toHaveValue('')
      expect((onNode.mock.calls.at(-1)?.[0] as Lifecycle).value).toBe('')
    })
  })
})
