import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { TraitValueField } from './TraitValueField.js'

/** Comfortably past the 250ms debounce. Used to prove the ABSENCE of a
 * request: a "no request yet" assertion made before the debounce could have
 * elapsed proves nothing at all. Every test that waits this long then goes
 * on to show a request DOES arrive once the operator interacts, which is
 * what makes the wait demonstrably long enough rather than merely hopeful. */
const PAST_DEBOUNCE = 400
const settle = () => new Promise((r) => setTimeout(r, PAST_DEBOUNCE))

function client(values: string[] = []): ApiClient {
  return { schemaTraitValues: vi.fn(async () => values) } as unknown as ApiClient
}

const suggestions = () =>
  Array.from(document.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'))

/** Controlled the way `ConditionRow` controls the real thing, so a typed
 * character survives to the next keystroke instead of the input snapping
 * back to its original value between them. */
function Harness(props: { client: ApiClient; trait?: string; operator?: string; value?: string }) {
  const [value, setValue] = useState<string>(props.value ?? '')
  return (
    <TraitValueField
      client={props.client}
      projectId={7}
      trait={props.trait ?? 'plan'}
      operator={props.operator ?? '='}
      value={value}
      onChange={(v) => setValue(v as string)}
    />
  )
}

describe('TraitValueField', () => {
  // THE eagerness pin, and the reason this component exists separately from
  // `PropertyCombobox`. The endpoint behind it scans the project's whole
  // trait partition; a segment builder renders one of these per condition
  // row, so a lookup on render would put N scans behind opening a screen
  // nobody has typed into yet. Asserting "suggestions appear after typing"
  // cannot tell an on-demand lookup from an eager one -- both end up with a
  // populated list -- so the absence is what has to be pinned, and pinned
  // AFTER the debounce has had time to fire.
  it('asks for nothing until the operator touches the box', async () => {
    const c = client(['free', 'pro'])
    render(<Harness client={c} />)

    await settle()
    expect(c.schemaTraitValues).not.toHaveBeenCalled()

    // ... and the same wait, after an interaction, does produce one. Without
    // this half the assertion above would also pass against a component that
    // never fetches at all.
    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalled())
  })

  // Nothing to suggest the values OF. The request would still be a partition
  // scan -- for a trait_key that matches no row -- so this is a cost guard,
  // not only a tidiness one.
  it('asks for nothing when no trait has been chosen', async () => {
    const c = client(['free'])
    render(<Harness client={c} trait="" />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await settle()
    expect(c.schemaTraitValues).not.toHaveBeenCalled()
  })

  // THE scoping test. Asserting merely that a lookup happened would pass
  // just as well for a request scoped to the wrong trait -- and a value list
  // for the wrong trait is worse than none, since it reads as authoritative.
  // The project id and the trait are both asserted, in that order, against a
  // trait name deliberately unlike anything else in the fixture.
  it('asks for the values of the trait the condition names', async () => {
    const c = client()
    render(<Harness client={c} trait="signup_source" />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'signup_source', ''))
  })

  it('offers what came back, attached to the box the operator is typing in', async () => {
    const c = client(['free', 'pro'])
    render(<Harness client={c} />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(suggestions()).toEqual(['free', 'pro']))

    // Options that exist but are attached to nothing are invisible to the
    // operator: the `list` attribute is the whole mechanism, so it is
    // asserted rather than assumed.
    const list = document.querySelector('datalist')
    expect(list?.id).toBeTruthy()
    expect(screen.getByRole('combobox', { name: /^value$/i })).toHaveAttribute('list', list?.id)
  })

  it('narrows the lookup with what has been typed so far', async () => {
    const c = client(['pro'])
    render(<Harness client={c} />)

    await userEvent.type(screen.getByRole('combobox', { name: /^value$/i }), 'pr')
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', 'pr'))
  })

  it('asks once for a burst of keystrokes, not once per key', async () => {
    const c = client()
    render(<Harness client={c} />)

    await userEvent.type(screen.getByRole('combobox', { name: /^value$/i }), 'abc')
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledTimes(1))
    expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', 'abc')
  })

  // Free-typed, never a whitelist -- the same rule the trait NAME field
  // follows, and for the same reason: a segment may be written ahead of the
  // data that will fill it.
  it('accepts a value the project has never recorded', async () => {
    const c = client(['free', 'pro'])
    render(<Harness client={c} />)

    const box = screen.getByRole('combobox', { name: /^value$/i })
    await userEvent.type(box, 'tier_2')
    expect(box).toHaveValue('tier_2')
  })

  it('says why the list is empty rather than showing an empty dropdown', async () => {
    render(<Harness client={client([])} />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    expect(await screen.findByText(/no values recorded for this trait/i)).toBeInTheDocument()
  })

  // Guards the "an answer arrived" half of that message. A never-settling
  // lookup must leave the field silent rather than assert an absence it has
  // no evidence for -- the same distinction `PropertyCombobox` draws with
  // its `fetched` flag.
  it('does not claim there are no values before the lookup answers', async () => {
    const c = {
      schemaTraitValues: vi.fn(() => new Promise<string[]>(() => {})),
    } as unknown as ApiClient
    render(<Harness client={c} />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalled())
    expect(screen.queryByText(/no values recorded/i)).not.toBeInTheDocument()
  })

  it('routes a 401 to onUnauthorized rather than a suggestion-failed notice', async () => {
    const onUnauthorized = vi.fn()
    const c = {
      schemaTraitValues: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    } as unknown as ApiClient
    render(
      <TraitValueField
        client={c}
        projectId={7}
        trait="plan"
        operator="="
        value=""
        onChange={vi.fn()}
        onUnauthorized={onUnauthorized}
      />,
    )

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a non-401 failure instead of implying the trait has no values', async () => {
    const c = {
      schemaTraitValues: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    } as unknown as ApiClient
    render(<Harness client={c} />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load suggestions/i)
    // "Could not load" must not read as "and now you are stuck".
    expect(screen.getByRole('combobox', { name: /^value$/i })).toBeEnabled()
    expect(screen.queryByText(/no values recorded/i)).not.toBeInTheDocument()
  })

  // Changing the trait invalidates the answer AND must not itself trigger a
  // new lookup: the trait field is a combobox the operator types into, so
  // re-asking on every change would put one partition scan behind every
  // keystroke of a DIFFERENT field -- precisely the eagerness the first test
  // in this file rules out for this one.
  it('drops the previous trait’s values on a trait change, without fetching again', async () => {
    const c = client(['free', 'pro'])
    const { rerender } = render(<Harness client={c} trait="plan" />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(suggestions()).toEqual(['free', 'pro']))

    rerender(<Harness client={c} trait="country" />)
    expect(suggestions()).toEqual([])
    await settle()
    expect(c.schemaTraitValues).toHaveBeenCalledTimes(1)
  })

  // The mirror of the test above, for the case where the answer is still in
  // flight when the trait changes. `plan`'s values must never surface under
  // `country`, however the timing falls.
  //
  // Honestly labelled: this one is doubly covered, and passes if EITHER the
  // trait-keyed answer or the cancellation flag survives -- each of which
  // has its own failing test elsewhere in this file. It is kept because what
  // it asserts is what the operator actually sees, and because the two
  // guards are only jointly sufficient here; it is not a pin for either one
  // on its own.
  it('does not show a late answer for the trait that has since been replaced', async () => {
    let release: (v: string[]) => void = () => {}
    const c = {
      schemaTraitValues: vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            release = resolve
          }),
      ),
    } as unknown as ApiClient
    const { rerender } = render(<Harness client={c} trait="plan" />)

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', ''))

    rerender(<Harness client={c} trait="country" />)
    release(['free', 'pro'])
    await settle()
    expect(suggestions()).toEqual([])
  })

  // Out-of-order responses for the SAME trait. The unfiltered lookup is
  // issued first and answers last; the narrower one the operator is actually
  // waiting on must not be overwritten by it.
  it('keeps the newest answer when an older lookup lands after it', async () => {
    const pending: ((v: string[]) => void)[] = []
    const c = {
      schemaTraitValues: vi.fn(() => new Promise<string[]>((resolve) => pending.push(resolve))),
    } as unknown as ApiClient
    render(<Harness client={c} />)

    const box = screen.getByRole('combobox', { name: /^value$/i })
    await userEvent.click(box)
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', ''))

    await userEvent.type(box, 'p')
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', 'p'))

    // Newest first, oldest second — the order that breaks a component that
    // simply writes whatever arrives.
    pending[1]?.(['pro'])
    await waitFor(() => expect(suggestions()).toEqual(['pro']))
    pending[0]?.(['enterprise', 'free', 'pro'])
    await settle()
    expect(suggestions()).toEqual(['pro'])
  })

  // `onUnauthorized` is re-created by every render of `App`, so a parent
  // render that has nothing to do with this field would otherwise re-run the
  // lookup effect and issue another partition scan. Interacted with once,
  // fetched once.
  it('does not re-fetch when an unrelated parent re-render replaces its callbacks', async () => {
    const c = client(['pro'])
    const { rerender } = render(
      <TraitValueField
        client={c}
        projectId={7}
        trait="plan"
        operator="="
        value=""
        onChange={vi.fn()}
        onUnauthorized={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledTimes(1))

    rerender(
      <TraitValueField
        client={c}
        projectId={7}
        trait="plan"
        operator="="
        value=""
        onChange={vi.fn()}
        onUnauthorized={() => {}}
      />,
    )
    await settle()
    expect(c.schemaTraitValues).toHaveBeenCalledTimes(1)
  })
})

describe('TraitValueField -- between', () => {
  function BetweenHarness(props: { client: ApiClient }) {
    const [value, setValue] = useState<[string, string]>(['', ''])
    return (
      <TraitValueField
        client={props.client}
        projectId={7}
        trait="plan"
        operator="between"
        value={value}
        onChange={(v) => setValue(v as [string, string])}
      />
    )
  }

  // Both bounds are values of the same trait, so both offer the same list.
  // Suggesting under one box and not the other would read as a broken field
  // rather than a policy -- and there is no policy to express: a bound that
  // is not itself a recorded value stays typeable either way.
  it('suggests under both bounds', async () => {
    const c = client(['free', 'pro'])
    render(<BetweenHarness client={c} />)

    await userEvent.click(screen.getByRole('combobox', { name: 'Value 1' }))
    await waitFor(() => expect(suggestions()).toEqual(['free', 'pro']))

    const list = document.querySelector('datalist')?.id
    expect(screen.getByRole('combobox', { name: 'Value 1' })).toHaveAttribute('list', list)
    expect(screen.getByRole('combobox', { name: 'Value 2' })).toHaveAttribute('list', list)
  })

  // The prefix comes from the box being edited, not from the whole value: a
  // lookup for the upper bound seeded with the lower bound's text would
  // filter against something nobody is typing.
  it('seeds the lookup from the bound being edited', async () => {
    const c = client()
    render(<BetweenHarness client={c} />)

    await userEvent.type(screen.getByRole('combobox', { name: 'Value 1' }), 'a')
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', 'a'))

    await userEvent.type(screen.getByRole('combobox', { name: 'Value 2' }), 'm')
    await waitFor(() => expect(c.schemaTraitValues).toHaveBeenCalledWith(7, 'plan', 'm'))
  })

  // The existing self-heal round trip still has to work with a suggestion
  // list bolted on: `between` with a scalar value expands to two boxes
  // through `ValueInput`'s own effect, and this component must not have
  // taken that over.
  it('still round-trips a scalar into two bounds', async () => {
    const onChange = vi.fn()
    render(
      <TraitValueField
        client={client()}
        projectId={7}
        trait="plan"
        operator="between"
        value="pro"
        onChange={onChange}
      />,
    )
    expect(onChange).toHaveBeenCalledWith(['pro', ''])
  })
})
