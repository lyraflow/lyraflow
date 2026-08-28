import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RetentionResult } from '../../api/types.js'
import { RetentionGrid } from './RetentionGrid.js'

const result = (over: Partial<RetentionResult> = {}): RetentionResult => ({
  granularity: 'week',
  periods: 3,
  cohorts: [
    { cohort: '2026-06-01', size: 4, retained: [4, 2, 1, null] },
    { cohort: '2026-06-08', size: 2, retained: [0, null, null, null] },
  ],
  start_event: 'signed_up',
  return_event: 'project_created',
  since: '2026-06-01T00:00:00.000Z',
  until: '2026-06-15T00:00:00.000Z',
  computed_at: '2026-06-20T00:00:00.000Z',
  warnings: [],
  ...over,
})

const rows = () => within(screen.getByTestId('retention-grid')).getAllByRole('row').slice(1)

describe('RetentionGrid', () => {
  it('renders an unmeasured cell as a dash, never as 0%', () => {
    render(<RetentionGrid result={result()} />)
    const second = rows()[1] as HTMLElement
    const cells = within(second).getAllByRole('cell')
    // size, then periods 0..3. Period 0 is a real zero; the rest are dashes.
    expect(cells[1]).toHaveTextContent('0%')
    expect(cells[2]).toHaveTextContent('—')
    expect(cells[2]).not.toHaveTextContent('0%')
  })

  it('distinguishes a measured zero from an unmeasured cell', () => {
    // The pair that matters. If these ever render the same, the screen is
    // reporting "not yet" as "nobody came back".
    render(<RetentionGrid result={result()} />)
    const second = within(rows()[1] as HTMLElement).getAllByRole('cell')
    expect(second[1]?.textContent).not.toBe(second[2]?.textContent)
  })

  it('shows the percentage of the cohort, with the count beside it', () => {
    render(<RetentionGrid result={result()} />)
    const first = within(rows()[0] as HTMLElement).getAllByRole('cell')
    expect(first[2]).toHaveTextContent('50%')
    expect(first[2]).toHaveTextContent('(2)')
  })

  it('names period 0 rather than numbering it', () => {
    render(<RetentionGrid result={result()} />)
    expect(screen.getByRole('columnheader', { name: 'Same week' })).toBeInTheDocument()
  })

  it('says so when there are no cohorts, instead of drawing an empty table', () => {
    render(<RetentionGrid result={result({ cohorts: [] })} />)
    expect(screen.getByTestId('retention-empty')).toHaveTextContent(/signed_up/)
    expect(screen.queryByTestId('retention-grid')).toBeNull()
  })

  it('gives one column per period plus the cohort and size columns', () => {
    render(<RetentionGrid result={result()} />)
    expect(screen.getAllByRole('columnheader')).toHaveLength(2 + 4)
  })
})
