import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedTile, TrendReport } from '../../api/types.js'
import type { RangeChoice } from '../shared/range.js'
import { TileCard, type TileStatus } from './TileCard.js'

const T = '2026-08-01T00:00:00.000Z'
const preset = (id: RangeChoice['preset']): RangeChoice => ({ preset: id, from: '', to: '' })

// Copied from `DashboardTile.test.tsx` -- a tile and its fetcher must agree
// on what a trend report looks like, so this is the same fixture rather
// than a second one that could quietly drift from it.
const TREND: TrendReport = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d',
  group_by: 'attribute:country',
  where: [{ property: 'plan', operator: '=', value: 'pro' }],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

const tile: ResolvedTile = { kind: 'trend', report_id: 1, width: 'half', report: TREND }

function mount(status: TileStatus, over: Partial<Parameters<typeof TileCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <TileCard
        tile={tile}
        range={preset('7d')}
        status={status}
        href="/trends/1?range=7d"
        editing={false}
        onRetry={() => {}}
        {...over}
      />
    </MemoryRouter>,
  )
}

describe('TileCard', () => {
  it('links the title when href is given, and renders plain text when it is null', () => {
    mount({ kind: 'loading' })
    expect(screen.getByRole('link', { name: TREND.name })).toHaveAttribute(
      'href',
      '/trends/1?range=7d',
    )
    mount({ kind: 'loading' }, { href: null })
    expect(screen.getAllByText(TREND.name)).toHaveLength(2)
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('busy shows its message and no Retry; error shows Retry which calls onRetry', async () => {
    const onRetry = vi.fn()
    mount({ kind: 'busy', message: 'Busy, retrying…' })
    expect(screen.getByText('Busy, retrying…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    mount({ kind: 'error', message: 'nope' }, { onRetry })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('a stale report with no href says so without an "Open it" link', () => {
    mount({ kind: 'loading' }, { tile: { ...tile, report: { ...TREND, stale: true } }, href: null })
    expect(screen.getByTestId('tile-stale')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open it' })).toBeNull()
  })

  it('renders a trend result', () => {
    mount({ kind: 'result', result: { kind: 'trend', page: { buckets: [] } } })
    expect(screen.getByTestId('tile-result')).toBeInTheDocument()
  })
})
