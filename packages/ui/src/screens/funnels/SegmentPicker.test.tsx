import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { SegmentPicker } from './SegmentPicker.js'

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
