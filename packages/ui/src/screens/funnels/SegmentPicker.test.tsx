import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { Segment } from '../../api/types.js'
import { SegmentPicker } from './SegmentPicker.js'

// A promise the test controls, so a guard gated on the fetch NOT having
// resolved yet (the `loaded` gate below) can actually be provoked instead
// of merely asserted against.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// The fields this test doesn't care about, so the one typed
// `deferred<Segment[]>()` resolution doesn't have to restate them.
const SEGMENT_DEFAULTS = {
  ast_version: 1,
  filter: null,
  last_count: null,
  last_evaluated_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

describe('SegmentPicker', () => {
  it('disables a stale segment and says why', async () => {
    const segments = vi.fn(async () => [
      { id: 1, name: 'Paying', stale: false },
      { id: 2, name: 'Broken', stale: true },
    ])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={() => {}}
      />,
    )
    const broken = await screen.findByRole('option', { name: /Broken/ })
    expect(broken).toBeDisabled()
    expect(broken).toHaveTextContent(/cannot be read/i)
  })

  it('defaults to Everyone, which sends segment_id: null', async () => {
    const onChange = vi.fn()
    render(
      <SegmentPicker
        client={{ segments: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={onChange}
      />,
    )
    expect(await screen.findByRole('option', { name: /everyone/i })).toBeInTheDocument()
  })
})

// Invented beyond the brief, from the stub check: a component that renders
// a hardcoded "Everyone" + fixed sample segments, never calling
// `client.segments` at all, satisfies both tests above unchanged -- neither
// asserts the client was ever touched, and a normal segment is never
// selected in either. These three close that gap.
describe('SegmentPicker -- invented mutations', () => {
  it('requests segments for the given project', async () => {
    const segments = vi.fn(async () => [{ id: 1, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={7}
        value={null}
        onChange={() => {}}
      />,
    )
    await screen.findByRole('option', { name: /Paying/ })
    expect(segments).toHaveBeenCalledWith(7)
  })

  it('reports a normal segment choice by id, not a hardcoded one', async () => {
    const onChange = vi.fn()
    const segments = vi.fn(async () => [{ id: 42, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={onChange}
      />,
    )
    await screen.findByRole('option', { name: /Paying/ })
    await userEvent.selectOptions(screen.getByLabelText('Segment'), '42')
    expect(onChange).toHaveBeenLastCalledWith(42)
  })

  it('renders an explicit unresolvable option, SELECTED, when the value has no matching segment', async () => {
    // I5: segment_id has no foreign key, deliberately -- a segment_id
    // absent from the list is a designed state (deleted elsewhere), not an
    // edge case. The mutation this pins: fall back to the native <select>'s
    // default behaviour for an unmatched value (silently reads as
    // "Everyone") -- exactly this test fails, because the select's own
    // value would then be "" instead of "missing".
    const segments = vi.fn(async () => [{ id: 1, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={4}
        onChange={() => {}}
      />,
    )
    const select = (await screen.findByLabelText('Segment')) as HTMLSelectElement
    await waitFor(() => expect(select).toHaveValue('missing'))
    expect(screen.getByText(/cannot be resolved/i)).toBeInTheDocument()
    expect(screen.getByText(/#4/)).toBeInTheDocument()
  })

  it('lets the operator deliberately clear an unresolvable segment by picking Everyone', async () => {
    const onChange = vi.fn()
    const segments = vi.fn(async () => [{ id: 1, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={4}
        onChange={onChange}
      />,
    )
    const select = (await screen.findByLabelText('Segment')) as HTMLSelectElement
    await waitFor(() => expect(select).toHaveValue('missing'))
    await userEvent.selectOptions(select, 'Everyone')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('does not show the unresolvable option once the segment list actually contains the value', async () => {
    const segments = vi.fn(async () => [{ id: 4, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={4}
        onChange={() => {}}
      />,
    )
    await screen.findByRole('option', { name: /Paying/ })
    expect(screen.queryByText(/cannot be resolved/i)).toBeNull()
  })

  // I5 (targeted re-review): `selectedMissing` is gated on `loaded` so a
  // value isn't read as unresolvable for the render(s) before the real list
  // arrives. The mutation this pins: drop `loaded &&` from the guard, and
  // this test alone fails -- the select would read "missing" (and render
  // the "cannot be resolved" text) BEFORE the fetch has had any chance to
  // say whether the segment is really absent.
  it('does not call a value unresolvable before the segment list has loaded', async () => {
    const pending = deferred<Segment[]>()
    render(
      <SegmentPicker
        client={{ segments: vi.fn(() => pending.promise) } as unknown as ApiClient}
        projectId={1}
        value={4}
        onChange={() => {}}
      />,
    )
    const select = screen.getByLabelText('Segment') as HTMLSelectElement
    expect(select).not.toHaveValue('missing')
    expect(screen.queryByText(/cannot be resolved/i)).toBeNull()

    // Resolving with a list that genuinely lacks id 4 -- NOW it may read
    // unresolvable.
    pending.resolve([{ ...SEGMENT_DEFAULTS, id: 1, name: 'Paying', stale: false }])
    await waitFor(() => expect(select).toHaveValue('missing'))
  })

  // I5 (targeted re-review): the "missing" option is a statement, not a
  // real choice -- re-selecting it must be a no-op. The mutation this pins:
  // drop the `if (next === 'missing') return` guard, and this test alone
  // fails -- `onChange` would be called with `Number('missing')`, i.e. NaN.
  it('reselecting the unresolvable option is a no-op, not a change to NaN', async () => {
    const onChange = vi.fn()
    const segments = vi.fn(async () => [{ id: 1, name: 'Paying', stale: false }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={4}
        onChange={onChange}
      />,
    )
    const select = (await screen.findByLabelText('Segment')) as HTMLSelectElement
    await waitFor(() => expect(select).toHaveValue('missing'))
    await userEvent.selectOptions(select, 'missing')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('a stale segment cannot be selected via selectOptions -- disabled is real, not cosmetic', async () => {
    const onChange = vi.fn()
    const segments = vi.fn(async () => [{ id: 2, name: 'Broken', stale: true }])
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={onChange}
      />,
    )
    await screen.findByRole('option', { name: /Broken/ })
    const select = screen.getByLabelText('Segment') as HTMLSelectElement
    // A disabled `<option>` refuses `userEvent.selectOptions` silently
    // (jsdom does not throw) -- the DOM's own selected value is what
    // actually proves the attempt had no effect, and no `change` event
    // fires for a no-op selection, so `onChange` must not have run either.
    await userEvent.selectOptions(select, '2')
    expect(select).toHaveValue('')
    expect(onChange).not.toHaveBeenCalled()
  })
})

// I6 (whole-branch review): every segments() failure -- INCLUDING 401 --
// used to be swallowed into an empty list, silently showing only
// "Everyone" for an expired session, the exact failure spec decision 6
// exists to prevent for the event autocomplete.
describe('SegmentPicker -- errors are never silently swallowed', () => {
  it('routes a 401 to onUnauthorized rather than rendering an empty list', async () => {
    const onUnauthorized = vi.fn()
    const segments = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={() => {}}
        onUnauthorized={onUnauthorized}
      />,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a non-401 failure instead of silently rendering only Everyone', async () => {
    const segments = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    })
    render(
      <SegmentPicker
        client={{ segments } as unknown as ApiClient}
        projectId={1}
        value={null}
        onChange={() => {}}
      />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load segments/i)
    // Everyone must stay usable even though the fetch failed.
    expect(screen.getByRole('option', { name: /everyone/i })).toBeInTheDocument()
  })
})
