import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { MIN_STEPS, StepRows } from './StepRows.js'

function fakeClient(): ApiClient {
  return { schemaEvents: vi.fn(async () => []) } as unknown as ApiClient
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

  it('disables the event field of a step carrying a CLI-authored predicate', () => {
    render(
      <StepRows
        client={fakeClient()}
        projectId={1}
        steps={[
          { event: 'a' },
          { event: 'b', where: [{ property: 'plan', op: '=', value: 'pro' }] },
        ]}
        onChange={() => {}}
      />,
    )
    expect(screen.getByLabelText('Step 1')).toBeEnabled()
    expect(screen.getByLabelText('Step 2')).toBeDisabled()
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
