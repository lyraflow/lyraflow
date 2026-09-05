import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RangePicker } from './RangePicker.js'
import { AUTO, CUSTOM, RANGE_PRESETS, type RangeChoice } from './range.js'

const choice = (preset: RangeChoice['preset'], from = '', to = ''): RangeChoice => ({
  preset,
  from,
  to,
})

describe('RangePicker', () => {
  it('offers every preset, custom included, and reveals the dates for custom', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RangePicker id="r" value={choice(AUTO)} onChange={onChange} />)
    expect(screen.getAllByRole('option')).toHaveLength(RANGE_PRESETS.length)
    expect(screen.getByRole('option', { name: 'Between two dates…' })).toBeInTheDocument()
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Range'), CUSTOM)
    expect(onChange).toHaveBeenCalledWith({ preset: CUSTOM, from: '', to: '' })

    rerender(<RangePicker id="r" value={choice(CUSTOM)} onChange={onChange} />)
    expect(screen.getByLabelText('From')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toBeInTheDocument()
  })

  // The shared viewer page's whole vocabulary is `SHARED_RANGE_PRESETS`, and
  // the public run route refuses anything else -- so offering `custom` there
  // would be offering a choice the server answers with a 400. The filter is
  // on the OPTIONS rather than on the handler because a control that lets a
  // person pick something and then declines it is worse than one that never
  // offered it.
  it('presetsOnly drops the custom option', () => {
    render(<RangePicker id="r" value={choice(AUTO)} onChange={vi.fn()} presetsOnly />)
    expect(screen.getAllByRole('option')).toHaveLength(RANGE_PRESETS.length - 1)
    expect(screen.queryByRole('option', { name: 'Between two dates…' })).toBeNull()
  })

  // The value can still ARRIVE as `custom` -- a pasted URL carrying
  // `?range=custom` reaches `readRange` before anything normalises it. The
  // dates must not appear then either: they are the one part of this control
  // that could put a range in the URL that the shared surface cannot send.
  it('presetsOnly renders no date inputs even when the value is custom', () => {
    render(
      <RangePicker
        id="r"
        value={choice(CUSTOM, '2026-01-01', '2026-01-02')}
        onChange={vi.fn()}
        presetsOnly
      />,
    )
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument()
  })
})
