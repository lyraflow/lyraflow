import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, segmentEditPath, segmentPath } from '../app/Router.js'
import { SegmentBuilder } from './SegmentBuilder.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

const TREE: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'pro' }],
}

const SEGMENT: Segment = {
  id: 7,
  name: 'Paying customers',
  ast_version: 1,
  filter: TREE,
  stale: false,
  last_count: 12,
  last_evaluated_at: '2026-08-15T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    segment: vi.fn(async () => SEGMENT),
    createSegment: vi.fn(async () => ({ ...SEGMENT, id: 42 })),
    updateSegmentTree: vi.fn(async () => SEGMENT),
    ...over,
  } as unknown as ApiClient & {
    segment: Mock
    createSegment: Mock
    updateSegmentTree: Mock
  }
}

function renderBuilder(client: ApiClient = fakeClient(), editId?: number) {
  render(
    <MemoryRouter initialEntries={[editId != null ? segmentEditPath(editId) : ROUTES.segmentNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path={ROUTES.segmentNew} element={<SegmentBuilder client={client} />} />
          <Route path="/segments/:id/edit" element={<SegmentBuilder client={client} />} />
          {/* Placeholders so a successful save's navigation has somewhere
           * to land, matching FunnelBuilder.test.tsx's own harness. */}
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
          <Route path="/segments/:id" element={<p>segment detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('SegmentBuilder -- create', () => {
  it('starts at an empty root, save disabled, and shows the empty state', async () => {
    renderBuilder()
    expect(await screen.findByTestId('group-')).toBeInTheDocument()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('enables save once a name is set and a condition exists, disabled again if either is missing', async () => {
    renderBuilder()
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('save creates the segment with the typed name and current tree, then navigates to the list', async () => {
    const client = fakeClient()
    renderBuilder(client)
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.createSegment).toHaveBeenCalledTimes(1))
    const call = client.createSegment.mock.calls[0]
    if (!call) throw new Error('createSegment was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe('VIPs')
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: '', operator: '=', value: '' }],
      },
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })

  it('routes a 401 on save to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      createSegment: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.segmentNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <SegmentBuilder client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SegmentBuilder -- edit', () => {
  it('seeds the name and tree from the fetched segment', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    expect(await screen.findByLabelText(/name/i)).toHaveValue('Paying customers')
    // Task 5 replaced the placeholder leaf (plain `summarise` text) with a
    // real `TraitForm` -- an `<input>`'s `value` is never DOM text content,
    // so the fetched trait's data is pinned through its own fields instead.
    const condition = within(screen.getByTestId('condition-0'))
    expect(condition.getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(condition.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(condition.getByRole('textbox', { name: /^value$/i })).toHaveValue('pro')
  })

  it('save sends the current tree through updateSegmentTree, never createSegment', async () => {
    const client = fakeClient()
    renderBuilder(client, SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(client.createSegment).not.toHaveBeenCalled()
    const call = client.updateSegmentTree.mock.calls[0]
    if (!call) throw new Error('updateSegmentTree was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe(SEGMENT.id)
    expect(call[2]).toEqual({ ast_version: 1, filter: TREE })
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
  })

  it('removing the only condition disables save and shows the empty state again', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /remove/i }),
    )
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
  })

  it('a stale segment cannot be edited here, and save is disabled', async () => {
    renderBuilder(
      fakeClient({ segment: vi.fn(async () => ({ ...SEGMENT, stale: true })) }),
      SEGMENT.id,
    )
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
    expect(screen.queryByTestId('group-')).toBeNull()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})
