import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { DeleteButton } from './DeleteButton.js'

const T = '2026-08-21T09:00:00.000Z'

/** A partial client double -- only the two methods this component calls,
 * same discipline as every other screen/component test in this package
 * (`Segments.test.tsx`, `ExportButton.test.tsx`). */
function makeClient(): ApiClient {
  return {
    deletePerson: vi.fn(async () => ({ request_id: 1, person_id: 'u1', suppressed_at: T })),
    deletion: vi.fn(async () => ({
      status: 'in_progress' as const,
      requested_at: T,
      completed_at: null,
    })),
  } as unknown as ApiClient
}

function base(client: ApiClient) {
  return { client, projectId: 1, personId: 'u1' }
}

let user: ReturnType<typeof userEvent.setup>

beforeEach(() => {
  // `shouldAdvanceTime` lets `user.click`/`user.type` resolve normally
  // while `vi.advanceTimersByTimeAsync` drives the poll effect's
  // `setInterval` -- see `ProjectsSection.test.tsx`'s own beforeEach and
  // task-6-harness-notes.md's fake-timer section.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ delay: null })
})

afterEach(() => {
  vi.useRealTimers()
})

async function click(name: RegExp) {
  await user.click(screen.getByRole('button', { name }))
}

async function type(labelPattern: RegExp, text: string) {
  await user.type(screen.getByLabelText(labelPattern), text)
}

/** Opens the confirmation, types the person id exactly, and confirms --
 * the flow every polling test below starts from. Mirrors
 * `ProjectsSection.test.tsx`'s own `confirmDelete`. */
async function confirmAndDelete(personId: string) {
  await click(/delete this person/i)
  await type(/type/i, personId)
  await click(/^delete$/i)
}

describe('DeleteButton', () => {
  it('will not delete until the person id is typed exactly', async () => {
    const client = makeClient()
    // `personId` after the spread, deliberately -- `base()` already
    // supplies one, and a spread later in JSX wins over an earlier
    // explicit prop, not the other way round.
    render(<DeleteButton {...base(client)} personId="cem@example.com" onDeleted={vi.fn()} />)
    await click(/delete this person/i)
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled()
    await type(/type/i, 'cem@example.co')
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeDisabled()
    await type(/type/i, 'm')
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled()
    // The client is never even asked until the gate opens.
    expect(client.deletePerson).not.toHaveBeenCalled()
  })

  it('states that the erasure is permanent and leaves suppression rows forever', async () => {
    const client = makeClient()
    render(<DeleteButton {...base(client)} onDeleted={vi.fn()} />)
    await click(/delete this person/i)
    const warning = screen.getByTestId('delete-warning')
    expect(warning).toHaveTextContent(/cannot be undone/i)
    expect(warning).toHaveTextContent(/permanent|forever/i)
  })

  it('polls to completion and then tells the profile to re-read', async () => {
    const client = makeClient()
    ;(client.deletePerson as Mock).mockResolvedValue({
      request_id: 9,
      person_id: 'u1',
      suppressed_at: T,
    })
    ;(client.deletion as Mock)
      .mockResolvedValueOnce({ status: 'in_progress', requested_at: T, completed_at: null })
      .mockResolvedValueOnce({ status: 'completed', requested_at: T, completed_at: T })
    const onDeleted = vi.fn()
    render(<DeleteButton onDeleted={onDeleted} {...base(client)} />)
    await confirmAndDelete('u1')
    await vi.advanceTimersByTimeAsync(6000)
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
  })

  it('surfaces the error on a failed deletion rather than reporting success', async () => {
    const client = makeClient()
    ;(client.deletion as Mock).mockResolvedValue({
      status: 'failed',
      requested_at: T,
      completed_at: null,
      error: 'clickhouse unreachable',
    })
    render(<DeleteButton {...base(client)} onDeleted={vi.fn()} />)
    await confirmAndDelete('u1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/clickhouse unreachable/)).toBeInTheDocument()
  })

  it('reports a pending retry as still running, with its error', async () => {
    // `pending` with an error means an attempt failed and another IS
    // coming. It is not `failed`, and it is not silence.
    const client = makeClient()
    ;(client.deletion as Mock).mockResolvedValue({
      status: 'pending',
      requested_at: T,
      completed_at: null,
      error: 'timeout',
    })
    render(<DeleteButton {...base(client)} onDeleted={vi.fn()} />)
    await confirmAndDelete('u1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/will be retried/i)).toBeInTheDocument()
    // The error that caused the retry is worth showing too, not just the
    // fact that one is coming.
    expect(screen.getByText(/timeout/)).toBeInTheDocument()
  })

  it('stops polling when unmounted', async () => {
    const client = makeClient()
    const { unmount } = render(<DeleteButton {...base(client)} onDeleted={vi.fn()} />)
    await confirmAndDelete('u1')
    // At least one tick before unmounting, so the mock could plausibly
    // record more -- proving the stop, not just that nothing happened to
    // fire yet.
    await vi.advanceTimersByTimeAsync(3000)
    const calls = (client.deletion as Mock).mock.calls.length
    expect(calls).toBeGreaterThan(0)
    unmount()
    await vi.advanceTimersByTimeAsync(10000)
    expect((client.deletion as Mock).mock.calls.length).toBe(calls)
  })

  it('reports a 401 starting a delete through onUnauthorized, not the generic error', async () => {
    const client = makeClient()
    ;(client.deletePerson as Mock).mockRejectedValue(new ApiError(401, 'no_session'))
    const onUnauthorized = vi.fn()
    render(<DeleteButton {...base(client)} onDeleted={vi.fn()} onUnauthorized={onUnauthorized} />)
    await confirmAndDelete('u1')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/could not start/i)).toBeNull()
  })

  it('reports a 401 from the poll through onUnauthorized, and stops polling', async () => {
    const client = makeClient()
    ;(client.deletion as Mock).mockRejectedValue(new ApiError(401, 'no_session'))
    const onUnauthorized = vi.fn()
    render(<DeleteButton {...base(client)} onDeleted={vi.fn()} onUnauthorized={onUnauthorized} />)
    await confirmAndDelete('u1')
    await vi.advanceTimersByTimeAsync(3500)
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    const calls = (client.deletion as Mock).mock.calls.length
    await vi.advanceTimersByTimeAsync(12000)
    expect((client.deletion as Mock).mock.calls.length).toBe(calls)
  })

  it('keeps polling through a poll failure that is not a 401', async () => {
    const client = makeClient()
    ;(client.deletion as Mock)
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValue({ status: 'completed', requested_at: T, completed_at: T })
    const onDeleted = vi.fn()
    const onUnauthorized = vi.fn()
    render(<DeleteButton {...base(client)} onDeleted={onDeleted} onUnauthorized={onUnauthorized} />)
    await confirmAndDelete('u1')
    await vi.advanceTimersByTimeAsync(7000)
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
