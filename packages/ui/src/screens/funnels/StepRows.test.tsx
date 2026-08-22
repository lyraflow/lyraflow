import type { FunnelStep } from '@lyraflow/core/funnels/ast.js'
import type { CostWarning } from '@lyraflow/core/segments/validate.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { MIN_STEPS, StepRows } from './StepRows.js'

function fakeClient(): ApiClient {
  return {
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
  } as unknown as ApiClient
}

/** Shared render harness for the audience tests below -- every other test
 * in this file passes every prop explicitly because each one is the thing
 * under test somewhere in the file, but the audience tests only ever vary
 * `steps`, `onChange` and `warnings`. Defaulting the rest here is what
 * keeps those tests reading as "what changed", not "what every prop was". */
function renderStepRows(overrides: {
  steps: FunnelStep[]
  onChange?: (steps: FunnelStep[]) => void
  warnings?: CostWarning[]
}) {
  return render(
    <StepRows
      client={fakeClient()}
      projectId={1}
      steps={overrides.steps}
      onChange={overrides.onChange ?? vi.fn()}
      warnings={overrides.warnings}
    />,
  )
}

/** TWO steps, each carrying TWO predicates -- the shape every predicate
 * test below needs and none of them may shrink.
 *
 * A single-predicate step cannot tell "edits the predicate you clicked"
 * from "edits the first predicate", and a single-step list cannot tell
 * "adds to the step you clicked" from "adds to step 1". Both wrong
 * implementations pass every assertion a one-of-each fixture can make. */
function twoStepsTwoPredicatesEach(): FunnelStep[] {
  return [
    {
      event: 'page_view',
      where: [
        { property: 'path', operator: '=', value: '/changelog' },
        { property: 'referrer', operator: '!=', value: 'internal' },
      ],
    },
    {
      event: 'signup_started',
      where: [
        { property: 'plan', operator: '=', value: 'pro' },
        { property: 'seats', operator: '>', value: 5 },
      ],
    },
  ]
}

describe('StepRows', () => {
  it('labels each row Step N in order', () => {
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByLabelText('Step 1')).toHaveValue('a')
    expect(screen.getByLabelText('Step 2')).toHaveValue('b')
  })

  it('adding a step appends one empty step at the end', async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /add step/i }))
    expect(onChange).toHaveBeenLastCalledWith([{ event: 'a' }, { event: 'b' }, { event: '' }])
  })

  it(`refuses to remove below ${MIN_STEPS} steps`, () => {
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /remove step 1/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /remove step 2/i })).toBeDisabled()
  })

  it('removes a step once above the floor', async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }, { event: 'c' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /remove step 2/i }))
    expect(onChange).toHaveBeenLastCalledWith([{ event: 'a' }, { event: 'c' }])
  })

  it('moves a step down, swapping positions rather than duplicating', async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /move step 1 down/i }))
    expect(onChange).toHaveBeenLastCalledWith([{ event: 'b' }, { event: 'a' }])
  })

  it('leaves the event field of a predicate-carrying step editable', async () => {
    // The inverse of the rule this component used to enforce: a step with a
    // `where` array is no longer locked, because the predicates can now be
    // edited here rather than only dropped or misrepresented.
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={twoStepsTwoPredicatesEach()}
        onChange={onChange}
      />,
    )
    expect(screen.getByLabelText('Step 1')).toBeEnabled()
    expect(screen.getByLabelText('Step 2')).toBeEnabled()

    await userEvent.type(screen.getByLabelText('Step 2'), 'x')
    // Retyping the event KEEPS the predicates -- clearing them would be
    // data loss on a step the operator may be mid-edit on. What changes is
    // only which event `PropertyCombobox` scopes its suggestions to.
    expect(onChange).toHaveBeenLastCalledWith([
      twoStepsTwoPredicatesEach()[0],
      { ...twoStepsTwoPredicatesEach()[1], event: 'signup_startedx' },
    ])
  })
})

describe('StepRows -- per-step where predicates', () => {
  it("renders each step's own predicates, operator included", () => {
    // Also the regression pin for the redeclared field name: this package
    // used to spell the operator `op` while the wire spells it `operator`,
    // so a stored predicate rendered with a blank operator. Reading the
    // operator off a rendered control is what catches that; reading the
    // property alone never would.
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={twoStepsTwoPredicatesEach()}
        onChange={() => {}}
      />,
    )
    const s1p0 = within(screen.getByTestId('step-1-where-0'))
    expect(s1p0.getByLabelText('Property or attribute')).toHaveValue('path')
    expect(s1p0.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(s1p0.getByRole('textbox', { name: /^value$/i })).toHaveValue('/changelog')

    const s2p1 = within(screen.getByTestId('step-2-where-1'))
    expect(s2p1.getByLabelText('Property or attribute')).toHaveValue('seats')
    expect(s2p1.getByRole('combobox', { name: /operator/i })).toHaveValue('>')
    expect(s2p1.getByRole('textbox', { name: /^value$/i })).toHaveValue('5')
  })

  it('editing a predicate changes that step and that predicate only', async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={twoStepsTwoPredicatesEach()}
        onChange={onChange}
      />,
    )
    await userEvent.selectOptions(
      within(screen.getByTestId('step-2-where-1')).getByRole('combobox', { name: /operator/i }),
      '<=',
    )
    expect(onChange).toHaveBeenLastCalledWith([
      twoStepsTwoPredicatesEach()[0],
      {
        event: 'signup_started',
        where: [
          { property: 'plan', operator: '=', value: 'pro' },
          { property: 'seats', operator: '<=', value: 5 },
        ],
      },
    ])
  })

  it('adds a predicate to the step whose own Add button was clicked', async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={twoStepsTwoPredicatesEach()}
        onChange={onChange}
      />,
    )
    await userEvent.click(
      within(screen.getByTestId('step-2-where')).getByRole('button', { name: /add predicate/i }),
    )
    expect(onChange).toHaveBeenLastCalledWith([
      twoStepsTwoPredicatesEach()[0],
      {
        event: 'signup_started',
        where: [
          { property: 'plan', operator: '=', value: 'pro' },
          { property: 'seats', operator: '>', value: 5 },
          { property: '', operator: '=', value: '' },
        ],
      },
    ])
  })

  it("removing a step's last predicate leaves the step with no `where` key at all", async () => {
    const onChange = vi.fn()
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[
          { event: 'page_view', where: [{ property: 'path', operator: '=', value: '/changelog' }] },
          { event: 'signup_started', where: [{ property: 'plan', operator: '=', value: 'pro' }] },
        ]}
        onChange={onChange}
      />,
    )
    await userEvent.click(
      within(screen.getByTestId('step-2-where-0')).getByRole('button', { name: /remove/i }),
    )
    // `toStrictEqual`, not `toEqual`: the point is that the key is GONE,
    // and `toEqual` treats `{ event, where: undefined }` as equal to
    // `{ event }` -- which is exactly the wrong shape this pins against.
    expect(onChange.mock.lastCall?.[0]).toStrictEqual([
      { event: 'page_view', where: [{ property: 'path', operator: '=', value: '/changelog' }] },
      { event: 'signup_started' },
    ])
  })

  it("scopes property suggestions to that step's own event", async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <StepRows
        client={{ schemaEvents: vi.fn(async () => []), schemaProperties } as unknown as ApiClient}
        projectId={7}
        steps={twoStepsTwoPredicatesEach()}
        onChange={() => {}}
      />,
    )
    await userEvent.type(
      within(screen.getByTestId('step-2-where-0')).getByLabelText('Property or attribute'),
      'x',
    )
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(7, 'signup_started', 'planx'))
    // Step 1's event must never have been asked about by step 2's field.
    expect(schemaProperties).not.toHaveBeenCalledWith(7, 'page_view', 'planx')
  })

  it('a step with no event yet scopes to every event, never to an empty event name', async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <StepRows
        client={{ schemaEvents: vi.fn(async () => []), schemaProperties } as unknown as ApiClient}
        projectId={7}
        steps={[
          { event: '', where: [{ property: 'path', operator: '=', value: '/a' }] },
          { event: 'b' },
        ]}
        onChange={() => {}}
      />,
    )
    await userEvent.type(
      within(screen.getByTestId('step-1-where-0')).getByLabelText('Property or attribute'),
      'x',
    )
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(7, undefined, 'pathx'))
  })

  it('threads onUnauthorized out of a predicate field, not just the event field', async () => {
    const onUnauthorized = vi.fn()
    const schemaProperties = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <StepRows
        client={{ schemaEvents: vi.fn(async () => []), schemaProperties } as unknown as ApiClient}
        projectId={1}
        steps={twoStepsTwoPredicatesEach()}
        onChange={() => {}}
        onUnauthorized={onUnauthorized}
      />,
    )
    await userEvent.type(
      within(screen.getByTestId('step-1-where-0')).getByLabelText('Property or attribute'),
      'x',
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})

// Invented beyond the brief, from the stub check: a component that renders
// two static rows and an inert "Add step" button that does nothing would
// still pass a naive "labels each row" assertion. This closes that gap by
// checking the boundary the floor exists to enforce, and the up-arrow
// boundary the reorder buttons must also respect.
describe('StepRows -- invented mutations', () => {
  it('the first row cannot move up, the last row cannot move down', () => {
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }, { event: 'c' }]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /move step 1 up/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /move step 3 down/i })).toBeDisabled()
  })

  // I6 (whole-branch review): StepRows never took or forwarded
  // `onUnauthorized` at all, so a 401 from an event step's own combobox had
  // no way out of this component even once EventCombobox itself learned to
  // report one.
  it("threads onUnauthorized down to each step's EventCombobox", async () => {
    const onUnauthorized = vi.fn()
    const schemaEvents = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <StepRows
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }]}
        onChange={() => {}}
        onUnauthorized={onUnauthorized}
      />,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'x')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })

  it('remove becomes enabled again once above the floor', () => {
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[{ event: 'a' }, { event: 'b' }, { event: 'c' }]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /remove step 1/i })).toBeEnabled()
  })
})

const behaviour = {
  kind: 'behavior' as const,
  event: 'docs_search',
  aggregate: 'count' as const,
  window: { kind: 'last' as const, n: 14, unit: 'days' as const },
  operator: '=' as const,
  value: 1,
}

describe('audiences', () => {
  it('offers no audience editor until the step asks for one', () => {
    renderStepRows({ steps: [{ event: 'a' }, { event: 'b' }] })
    // Eight always-rendered tree editors would bury the event field, which
    // is still the step's primary content.
    expect(screen.queryByTestId('group-')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /add audience to step/i })).toHaveLength(2)
  })

  it('seeds an empty AND group when a step adds an audience', async () => {
    const onChange = vi.fn()
    renderStepRows({ steps: [{ event: 'a' }, { event: 'b' }], onChange })
    await userEvent.click(screen.getByRole('button', { name: 'Add audience to step 1' }))
    // Seeded with ONE default condition, never empty -- `GroupCard`'s own
    // `newGroup` comment says why: a group with zero children is invalid
    // against `children.min(1)` the instant it exists, and "the server
    // rejects it at save time" is a guard that fires after the fact rather
    // than a rule that keeps the state unreachable. Reusing `newCondition`
    // rather than restating it keeps "Add audience" and "Add condition"
    // agreeing on what a freshly-added condition looks like.
    expect(onChange).toHaveBeenCalledWith([
      {
        event: 'a',
        audience: {
          kind: 'group',
          op: 'and',
          children: [{ kind: 'trait', key: '', operator: '=', value: '' }],
        },
      },
      { event: 'b' },
    ])
  })

  it('drops the key entirely when a step’s audience is removed', async () => {
    const onChange = vi.fn()
    renderStepRows({
      // Group-rooted, like every audience `StepRows` ever renders --
      // `step.audience` is documented as ALREADY NORMALISED by the time it
      // reaches this component (`FunnelBuilder` does it on load, Task 6).
      // A bare leaf here would crash `GroupCard`, which is exactly the
      // seam `normaliseRoot`'s own doc comment describes: this component
      // deliberately does not normalise at render, so a fixture that is
      // not already normalised is not a state it is ever handed.
      steps: [
        { event: 'a', audience: { kind: 'group', op: 'and', children: [behaviour] } },
        { event: 'b' },
      ],
      onChange,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Remove audience from step 1' }))
    // The KEY is dropped, not set to undefined -- `audience` is
    // `.optional()`, so "absent" is the shape a step that never had one is
    // stored with, and a step whose condition was removed must round-trip
    // to exactly that. Same rule `updateWhere` already follows.
    expect(onChange).toHaveBeenCalledWith([{ event: 'a' }, { event: 'b' }])
    expect(Object.keys(onChange.mock.lastCall?.[0]?.[0] ?? {})).toEqual(['event'])
  })

  it('shows a step’s own warning on that step, and not on its neighbour', () => {
    // Group-rooted, same reason as the removal test above: `step.audience`
    // reaches `StepRows` already normalised, so each condition sits one
    // level below the root, at editor path `[0]` -- `filter.children[0]`
    // in `costWarnings`' own dotted path, `steps.<i>.filter.children[0]`
    // once `funnelCostWarnings` prefixes it.
    renderStepRows({
      steps: [
        {
          event: 'a',
          audience: {
            kind: 'group',
            op: 'and',
            children: [{ ...behaviour, window: { kind: 'ever' } }],
          },
        },
        {
          event: 'b',
          audience: {
            kind: 'group',
            op: 'and',
            children: [{ ...behaviour, window: { kind: 'last', n: 7, unit: 'days' } }],
          },
        },
      ],
      warnings: [
        {
          path: 'steps.0.filter.children[0]',
          reason:
            'the `docs_search` condition uses an `ever` window, which scans all history rather than a bounded window',
        },
      ],
    })
    // Both steps' conditions sit at editor path [0] -- so handing the whole
    // funnel's list to every step would render this on both. Filtering by
    // the `steps.<i>.` prefix is what keeps it on step 1.
    const step1 = screen.getByTestId('step-1-audience')
    const step2 = screen.getByTestId('step-2-audience')
    expect(within(step1).getByText(/scans all history/)).toBeInTheDocument()
    expect(within(step2).queryByText(/scans all history/)).not.toBeInTheDocument()
  })
})
