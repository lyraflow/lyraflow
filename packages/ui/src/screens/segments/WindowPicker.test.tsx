import { Window as WindowSchema } from '@lyraflow/core/segments/ast.js'
import type { Window } from '@lyraflow/core/segments/ast.js'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WindowPicker, zoneNote } from './WindowPicker.js'
import { WINDOW_KIND_OPTIONS } from './vocabulary.js'

describe('WindowPicker', () => {
  it('renders the last-variant fields (amount, unit) when given a `last` window', () => {
    const value: Window = { kind: 'last', n: 30, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveValue(30)
    expect(screen.getByLabelText('Window unit')).toHaveValue('days')
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('renders the absolute-variant fields (from, to) when given an `absolute` window', () => {
    const value: Window = { kind: 'absolute', from: '2026-01-01T00:00', to: '2026-02-01T00:00' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01T00:00')
    expect(screen.getByLabelText('To')).toHaveValue('2026-02-01T00:00')
    expect(screen.queryByLabelText('Window amount')).toBeNull()
  })

  it('renders no extra fields for `ever`', () => {
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Window amount')).toBeNull()
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('switching from `last` to `absolute` does not leave n/unit on the node', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 30, unit: 'days' }} onChange={onChange} />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'absolute')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'absolute', from: '', to: '' })
  })

  it('switching from `absolute` to `ever` does not leave from/to on the node', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker
        id="beh"
        value={{ kind: 'absolute', from: '2026-01-01T00:00', to: '2026-02-01T00:00' }}
        onChange={onChange}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'ever')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'ever' })
  })

  it('switching from `ever` to `last` seeds a fresh positive n and unit, not stale/zero fields', async () => {
    const onChange = vi.fn()
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'last')
    const call = onChange.mock.calls.at(-1)?.[0] as Window
    expect(call.kind).toBe('last')
    expect(call).toEqual({ kind: 'last', n: 1, unit: 'days' })
  })

  it('editing the amount keeps the current unit, and editing the unit keeps the current amount', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 7, unit: 'hours' }} onChange={onChange} />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window unit'), 'days')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'last', n: 7, unit: 'days' })
  })

  it('flags a non-positive amount as invalid, not merely accepting it silently', () => {
    const value: Window = { kind: 'last', n: 0, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/enter a whole number/i)).toBeInTheDocument()
  })

  it('flags an unsafe integer amount as invalid -- Number.isSafeInteger, not Number.isInteger', () => {
    // 1e20 is `Number.isInteger`-true but not a safe integer -- the fifth
    // (now sixth) home of this exact bug class in this repository. Pinned
    // directly on the node's `n`, not by typing it through the input, so
    // this holds regardless of how a value this large could arrive (a
    // CLI-authored segment, not just this control).
    const value: Window = { kind: 'last', n: 1e20, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'true')
  })

  // `ast.ts` bounds `last.n` above
  // too -- `z.number().int().positive().max(3650)` -- and the original
  // version of this control checked only the lower bound. 3650 and 3651
  // together pin the actual boundary rather than just "some large number
  // is fine", the same shape as the safe-integer test above pinning where
  // the lower/unsafe boundary actually falls.
  it('a value at the AST upper bound (3650) is not flagged invalid', () => {
    const value: Window = { kind: 'last', n: 3650, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'false')
  })

  it('one past the AST upper bound (3651) is flagged invalid', () => {
    const value: Window = { kind: 'last', n: 3651, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/enter a whole number/i)).toBeInTheDocument()
  })

  // --- The words. Presentation only: every `value` below is the AST's own
  // `kind`, unchanged, which is what keeps the tests above (and every other
  // file that selects a window by value) working untouched.

  it('offers the three modes as plain words rather than as the AST’s kinds', () => {
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 30, unit: 'days' }} onChange={vi.fn()} />,
    )
    const options = Array.from(
      screen.getByLabelText('Window').querySelectorAll('option'),
    ) as HTMLOptionElement[]
    expect(options.map((o) => o.value)).toEqual(['last', 'absolute', 'ever'])
    expect(options.map((o) => o.textContent)).toEqual([
      'in the last…',
      'between two dates',
      'any time',
    ])
    // ...and they are the SHARED words, from the one module `summarise` reads
    // too. A control with its own private copy of this list is how the list
    // screen came to say "in ever" while this select said "any time".
    expect(options.map((o) => o.value)).toEqual(WINDOW_KIND_OPTIONS.map((o) => o.kind))
    expect(options.map((o) => o.textContent)).toEqual(WINDOW_KIND_OPTIONS.map((o) => o.label))
  })

  it('states what `any time` costs beside the control that chooses it, not only after the fact', () => {
    // Rendered ALONE, with no `ConditionRow` and therefore no cost-warning
    // list anywhere on screen: what this asserts can only have come from the
    // picker itself. `costWarnings`' own sentence stays where it was; this is
    // the additional one, at the point of choice.
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={vi.fn()} />)
    expect(screen.getByText(/most expensive window/i)).toBeInTheDocument()
  })

  it('says nothing about cost for a bounded window', () => {
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 30, unit: 'days' }} onChange={vi.fn()} />,
    )
    expect(screen.queryByText(/most expensive window/i)).toBeNull()
  })
})

/**
 * The absolute window's own suite, in a zone that is NOT UTC.
 *
 * The container this runs in defaults to UTC, where a correct conversion and
 * no conversion at all agree on every value -- so every assertion below would
 * pass against the defect it exists to catch. `datetime.test.ts`'s own header
 * has the full reasoning and the same fixtures; `+05:30` at `10:00` differs
 * from UTC in both the hour and the minute.
 */
describe('WindowPicker -- the absolute window stores UTC and displays local', () => {
  const ZONE = 'Asia/Kolkata'
  const LOCAL = '2026-08-01T10:00'
  const INSTANT = '2026-08-01T04:30:00.000Z'
  const LOCAL_TO = '2026-09-01T02:00'
  const INSTANT_TO = '2026-08-31T20:30:00.000Z'

  // Via `vi.stubEnv`, not a direct `process.env` write: this package carries
  // no `@types/node`, and CI typechecks before it runs anything.
  beforeAll(() => {
    vi.stubEnv('TZ', ZONE)
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
    // Guards every assertion below. In UTC -- the container's own default --
    // a correct conversion and no conversion at all agree on every fixture
    // here, so this suite would pass against the very defect it exists for.
    expect(new Date(LOCAL).toISOString()).toBe(INSTANT)
  })

  /** The picker wired to real state, which is the only way a ROUND TRIP can
   * be observed: a conversion applied on write but not on read is invisible
   * to a test that drives one direction and asserts on the callback. */
  function Stateful(props: { initial: Window; onChange?: (next: Window) => void }) {
    const [value, setValue] = useState<Window>(props.initial)
    return (
      <WindowPicker
        id="beh"
        value={value}
        onChange={(next) => {
          setValue(next)
          props.onChange?.(next)
        }}
      />
    )
  }

  const EMPTY: Window = { kind: 'absolute', from: '', to: '' }

  it('writes the From bound as the UTC instant the local reading names', () => {
    const onChange = vi.fn()
    render(<WindowPicker id="beh" value={EMPTY} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: LOCAL } })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'absolute', from: INSTANT, to: '' })
  })

  it('writes the To bound as the UTC instant the local reading names', () => {
    const onChange = vi.fn()
    render(<WindowPicker id="beh" value={EMPTY} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('To'), { target: { value: LOCAL_TO } })
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'absolute', from: '', to: INSTANT_TO })
  })

  it('displays a stored UTC instant as the local reading, not as the raw string', () => {
    render(
      <WindowPicker
        id="beh"
        value={{ kind: 'absolute', from: INSTANT, to: INSTANT_TO }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('From')).toHaveValue(LOCAL)
    expect(screen.getByLabelText('To')).toHaveValue(LOCAL_TO)
  })

  it('round-trips: what the operator entered is what the picker shows back', () => {
    render(<Stateful initial={EMPTY} />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: LOCAL } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: LOCAL_TO } })
    expect(screen.getByLabelText('From')).toHaveValue(LOCAL)
    expect(screen.getByLabelText('To')).toHaveValue(LOCAL_TO)
  })

  it('produces a window the AST accepts once both bounds are filled in -- which it never did', () => {
    // The defect as the operator met it: choose an absolute range, fill both
    // fields, and the tree the screen produced was one the server refused,
    // so the builder reported the condition as unfinished. Asserted against
    // the REAL schema from core rather than against a string shape, because
    // the string shape is what was wrong.
    let latest: Window = EMPTY
    render(
      <Stateful
        initial={EMPTY}
        onChange={(next) => {
          latest = next
        }}
      />,
    )
    expect(WindowSchema.safeParse(EMPTY).success).toBe(false)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: LOCAL } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: LOCAL_TO } })
    expect(WindowSchema.safeParse(latest).success).toBe(true)
  })

  it('names the zone the operator is reading, taken from the runtime', () => {
    render(<WindowPicker id="beh" value={EMPTY} onChange={vi.fn()} />)
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(screen.getByText(new RegExp(`Times are in ${zone}`))).toBeInTheDocument()
  })

  it('says nothing about a timezone when no absolute range is being chosen', () => {
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={vi.fn()} />)
    expect(screen.queryByText(/Times are in/)).toBeNull()
  })

  /**
   * Both branches against a literal zone name rather than against the host's
   * own -- which is the only way either branch can be checked at all. A test
   * that could ask only about the runtime's zone would exercise the UTC branch
   * on a container and the named branch on a laptop, and never both, which is
   * precisely how the doubled sentence shipped.
   */
  describe('the zone note', () => {
    it('names the zone and says where times are stored, when the two differ', () => {
      expect(zoneNote('Asia/Kolkata')).toBe(
        "Times are in Asia/Kolkata, your browser's timezone. They are stored and counted in UTC.",
      )
    })

    it('says UTC ONCE when the browser is already on UTC, instead of stating it twice', () => {
      // What rendered before: "Times are in UTC, your browser's timezone. They
      // are stored and counted in UTC." -- the same fact twice, on any
      // container, CI runner, server, or host with `TZ` unset, which reads as
      // a bug in the page rather than a note about it.
      const note = zoneNote('UTC')
      expect(note).toBe("Times are in UTC, your browser's timezone.")
      expect(note).not.toMatch(/stored and counted/)
      expect(note.match(/UTC/g)).toHaveLength(1)
    })

    it('treats any UTC-named zone the same way, without a list of names to maintain', () => {
      // `Etc/UTC` is the same zone under the name a container is most likely
      // to actually report. The rule is about the SENTENCE -- has naming the
      // zone already said the word -- so it needs no tz-database list.
      expect(zoneNote('Etc/UTC')).toBe("Times are in Etc/UTC, your browser's timezone.")
      expect(zoneNote('Etc/UTC')).not.toMatch(/stored and counted/)
    })
  })

  it('clearing a bound returns it to empty rather than to some invented instant', () => {
    render(<Stateful initial={{ kind: 'absolute', from: INSTANT, to: INSTANT_TO }} />)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } })
    expect(screen.getByLabelText('From')).toHaveValue('')
    expect(screen.getByLabelText('To')).toHaveValue(LOCAL_TO)
  })
})
