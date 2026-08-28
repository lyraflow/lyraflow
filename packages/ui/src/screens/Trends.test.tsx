import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
import type { StatsPage } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Trends } from './Trends.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

const PAGE: StatsPage = {
  buckets: [
    { bucket: '2026-06-01T00:00:00.000Z', series: 'pro', events: 5 },
    { bucket: '2026-06-02T00:00:00.000Z', series: 'pro', events: 3 },
    { bucket: '2026-06-01T00:00:00.000Z', series: 'free', events: 2 },
  ],
  folded_series: 0,
}

function harness(over: Partial<ApiClient> = {}, url = '/trends') {
  const client = {
    stats: vi.fn(async () => PAGE),
    schemaEvents: vi.fn(async () => ['checkout', 'signup']),
    schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Trends client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

const runButton = () => screen.getByRole('button', { name: /^run$/i })
const SPLIT = '/trends?event=checkout&source=property&field=plan'

describe('Trends', () => {
  it('does not run on render -- an aggregate is a real scan', async () => {
    const client = harness({}, SPLIT)
    await new Promise((r) => setTimeout(r, 20))
    expect(client.stats).not.toHaveBeenCalled()
  })

  it('sends the breakdown from the URL in the endpoint the server parses', async () => {
    const client = harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, {
      interval: '1d',
      event: 'checkout',
      group_by: 'property:plan',
    })
  })

  it('omits group_by entirely when nothing is split', async () => {
    const client = harness({}, '/trends?event=checkout')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, { interval: '1d', event: 'checkout' })
  })

  it('sends no group_by for a half-finished split, and says the split is unfinished', async () => {
    // Sending `property:` would be a 400 the operator did not ask for.
    const client = harness({}, '/trends?event=checkout&source=property')
    expect(screen.getByTestId('trend-incomplete-split')).toBeInTheDocument()
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, { interval: '1d', event: 'checkout' })
  })

  it('clears the chart when the definition changes', async () => {
    harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /resolution/i }), '1w')
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })

  it('clears the field when the split source changes', async () => {
    // `utm_source` is a valid column and an unlikely property name; carrying
    // it across would silently ask a different question.
    harness({}, '/trends?event=checkout&source=attribute&field=utm_source')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /split by/i }), 'property')
    expect(screen.queryByDisplayValue('utm_source')).toBeNull()
  })

  it('says how many series were folded, so the panels reconcile with the total', async () => {
    const folded = vi.fn(async () => ({ ...PAGE, folded_series: 340 }))
    harness({ stats: folded } as unknown as Partial<ApiClient>, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-folded')).toBeInTheDocument())
    expect(screen.getByTestId('trend-folded')).toHaveTextContent('340')
  })

  it('says nothing about folding when nothing was folded', async () => {
    harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    expect(screen.queryByTestId('trend-folded')).toBeNull()
  })

  it('reports a failure instead of leaving the previous chart on screen', async () => {
    const failing = vi.fn(async () => {
      throw new Error('too many series')
    })
    harness({ stats: failing } as unknown as Partial<ApiClient>, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many series/))
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })

  it('puts no description inside the controls row, so nothing lifts out of alignment', () => {
    // The row is `items-end` so the Run button lines up with the inputs, and
    // that holds only while every column is the same height. A hint paragraph
    // under the Property field made its column taller and pushed the field
    // itself visibly UP -- reported as a glitch on 2026-08-28. Explanations
    // go below the row.
    harness({}, '/trends?event=checkout&source=property&field=plan')
    const row = screen.getByTestId('trend-controls')
    expect(row.querySelectorAll('p')).toHaveLength(0)
  })

  it('still explains what a property is, below the row rather than inside it', () => {
    harness({}, '/trends?event=checkout&source=property&field=plan')
    expect(screen.getByText(/whatever your app put in/i)).toBeInTheDocument()
    expect(screen.getByTestId('trend-controls')).not.toContainElement(
      screen.getByText(/whatever your app put in/i),
    )
  })

  it('sends no bounds on the default range, keeping the server’s tuned window', async () => {
    const client = harness({}, '/trends?event=checkout')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    const q = (client.stats as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, unknown>
    expect('since' in q).toBe(false)
    expect('until' in q).toBe(false)
  })

  it('sends bounds once a range is chosen', async () => {
    const client = harness({}, '/trends?event=checkout&range=90d')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    const q = (client.stats as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, string>
    expect(new Date(q.until as string).getTime() - new Date(q.since as string).getTime()).toBe(
      90 * 86_400_000,
    )
  })

  it('refuses a span-and-resolution pairing the server would refuse, before sending it', async () => {
    // 30 days at one-minute resolution is 43,200 buckets against a ceiling of
    // 1000. Saying so beats a 400 the operator has to interpret.
    const client = harness({}, '/trends?event=checkout&interval=1m&range=30d')
    expect(screen.getByTestId('trend-too-many-buckets')).toHaveTextContent('43,200')
    expect(runButton()).toBeDisabled()
    expect(client.stats).not.toHaveBeenCalled()
  })

  it('blocks a half-filled custom range instead of pairing a start with no end', async () => {
    harness({}, '/trends?event=checkout&range=custom&from=2026-06-01')
    expect(screen.getByTestId('trend-range-unfinished')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
  })

  it('clears the chart when the range changes, like every other control', async () => {
    harness({}, '/trends?event=checkout&range=90d')
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /range/i }), '30d')
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })
})
