import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SavedReportList } from './SavedReportList.js'
import type { SavedReportRow } from './SavedReportList.js'

const ROW: SavedReportRow = {
  id: 3,
  name: 'Signups by day',
  summary: 'signup · daily · by country',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

function renderRows(
  rows: SavedReportRow[] | null,
  overrides: Partial<{
    loadFailed: boolean
    onDelete(id: number): Promise<void>
  }> = {},
) {
  const onDelete = overrides.onDelete ?? vi.fn(async () => {})
  render(
    <MemoryRouter>
      <SavedReportList
        rows={rows}
        loadFailed={overrides.loadFailed ?? false}
        hrefFor={(id) => `/reports/${id}`}
        onDelete={onDelete}
        newHref="/reports/new"
        emptyMessage="Nothing saved here yet."
      />
    </MemoryRouter>,
  )
  return { onDelete }
}

async function click(name: RegExp) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name }))
}

describe('SavedReportList', () => {
  it('renders nothing while still loading', () => {
    render(
      <MemoryRouter>
        <SavedReportList
          rows={null}
          loadFailed={false}
          hrefFor={(id) => `/reports/${id}`}
          onDelete={vi.fn()}
          newHref="/reports/new"
          emptyMessage="Nothing saved here yet."
        />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/nothing saved here yet/i)).toBeNull()
  })

  it('links each row to hrefFor(id) and shows its summary', () => {
    renderRows([ROW])
    const link = screen.getByRole('link', { name: /Signups by day/ })
    expect(link).toHaveAttribute('href', '/reports/3')
    expect(screen.getByText('signup · daily · by country')).toBeInTheDocument()
  })

  it('shows the empty message and a way to create one, only when rows is an empty array', () => {
    renderRows([])
    expect(screen.getByText(/nothing saved here yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create one/i })).toHaveAttribute(
      'href',
      '/reports/new',
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('distinguishes a failed load from an empty list', () => {
    renderRows([], { loadFailed: true })
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.queryByText(/nothing saved here yet/i)).toBeNull()
  })

  it('requires a confirm before calling onDelete, and passes the row id', async () => {
    const { onDelete } = renderRows([ROW])
    await click(/^delete$/i)
    expect(onDelete).not.toHaveBeenCalled()
    await click(/^confirm$/i)
    expect(onDelete).toHaveBeenCalledWith(3)
  })

  it('cancel closes the confirm step without calling onDelete', async () => {
    const { onDelete } = renderRows([ROW])
    await click(/^delete$/i)
    await click(/^cancel$/i)
    expect(screen.queryByRole('button', { name: /^confirm$/i })).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows an error and re-offers delete when onDelete rejects', async () => {
    const onDelete = vi.fn(async () => {
      throw new Error('boom')
    })
    renderRows([ROW], { onDelete })
    await click(/^delete$/i)
    await click(/^confirm$/i)
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not delete/i)
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })
})
