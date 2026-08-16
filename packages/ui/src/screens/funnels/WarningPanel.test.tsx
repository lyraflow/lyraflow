import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WarningPanel } from './WarningPanel.js'

describe('WarningPanel', () => {
  it('renders EVERY warning, not merely the first', () => {
    render(
      <WarningPanel
        warnings={[
          { path: 'range', reason: 'first reason' },
          { path: 'steps.0', reason: 'second reason' },
          { path: 'segment', reason: 'third reason' },
        ]}
      />,
    )
    expect(screen.getByText('first reason')).toBeInTheDocument()
    expect(screen.getByText('second reason')).toBeInTheDocument()
    expect(screen.getByText('third reason')).toBeInTheDocument()
  })

  it('renders the server prose verbatim rather than a rewritten summary', () => {
    const reason =
      '312 of the people who entered did so too recently to have had the full 604800-second window, and can still convert'
    render(<WarningPanel warnings={[{ path: 'range', reason }]} />)
    expect(screen.getByText(reason)).toBeInTheDocument()
  })

  it('has no dismiss control', () => {
    render(<WarningPanel warnings={[{ path: 'range', reason: 'x' }]} />)
    expect(screen.queryByRole('button', { name: /dismiss|close/i })).toBeNull()
  })

  it('renders nothing at all when there are no warnings', () => {
    const { container } = render(<WarningPanel warnings={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
