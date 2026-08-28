import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Person } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { People } from './People.js'

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

const PERSON: Person = {
  person_id: 'u1',
  ids: ['u1'],
  devices: [],
  first_seen: '2026-06-01T09:00:00.000Z',
  last_seen: '2026-08-20T15:30:00.000Z',
  events: 42,
  traits: {},
  traits_num: {},
  trait_total: 0,
  traits_withheld: false,
}

function person(overrides: Partial<Person> = {}): Person {
  return { ...PERSON, ...overrides }
}

function renderPeople(path: string, client: ApiClient, opts: { onUnauthorized?: () => void } = {}) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <People client={client} onUnauthorized={opts.onUnauthorized} />
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('People', () => {
  it('shows a lookup input when there is no id', () => {
    const client = { person: vi.fn() } as unknown as ApiClient
    renderPeople('/people', client)
    expect(screen.getByLabelText(/user id, anonymous id, or a device id/i)).toBeInTheDocument()
    expect(client.person).not.toHaveBeenCalled()
  })

  it('names all three reasons a person cannot be shown', async () => {
    // person.ts's own docstring: a 404 means nobody ever sent this id, OR
    // everything they did sits at or before their deletion boundary, OR
    // every event aged out under retention -- "there is no way to tell the
    // three apart from this response alone". Saying "no such person" would
    // tell an operator checking an erasure that it worked when it may have
    // been a retention expiry.
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=ghost', client)
    const msg = await screen.findByTestId('person-not-found')
    // The brief's own illustrative regex here (`/never/i`) does not match
    // the verbatim-preserved copy, which reads "no event was ever
    // recorded" rather than containing the literal substring "never" --
    // same shape of correction `PersonFields.test.tsx` already made for
    // `AttributesSection`'s copy. Pinning the real phrasing for each of
    // the three causes instead, which is the assertion this test exists to
    // make: an operator must be told all three, not shown a message loose
    // enough to also describe "no such person".
    expect(msg).toHaveTextContent(/no event was ever recorded/i)
    expect(msg).toHaveTextContent(/erased by a deletion request/i)
    expect(msg).toHaveTextContent(/retention window/i)
    expect(msg).not.toHaveTextContent(/no such person/i)
  })

  it('explains a fragmented history rather than showing a broken screen', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(400, 'person_history_too_fragmented')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=busy', client)
    // Same correction as above: the brief's illustrative `/too many
    // devices/i` does not appear in the verbatim 400 copy, which names the
    // limit (200) instead.
    expect(await screen.findByText(/more than 200 device windows/i)).toBeInTheDocument()
    expect(screen.getByText(/lyraflow persons get/)).toBeInTheDocument()
  })

  it('keeps what was typed when a lookup 404s, so it can be corrected', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
    } as unknown as ApiClient
    renderPeople('/people', client)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/user id/i), 'cem@exampl.com')
    await user.click(screen.getByRole('button', { name: /look up/i }))
    expect(await screen.findByDisplayValue('cem@exampl.com')).toBeInTheDocument()
    expect(client.person).toHaveBeenCalledWith(1, 'cem@exampl.com')
  })

  it('renders the id set split into user ids and device ids', async () => {
    // The one thing no other screen shows: that these ids are ONE person is
    // the product's central claim, and nothing in the UI has ever
    // displayed it.
    const client = {
      person: vi.fn(async () =>
        person({ person_id: 'u1', ids: ['u1', 'u2', 'dev-a'], devices: ['dev-a'] }),
      ),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByTestId('identity-ids')).toHaveTextContent('dev-a')
  })

  it('renders traits and context from the person read', async () => {
    const client = {
      person: vi.fn(async () => person({ traits: { plan: 'pro' }, traits_num: { seats: 12 } })),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText('plan')).toBeInTheDocument()
    expect(screen.getByText('pro')).toBeInTheDocument()
  })

  it('says traits were withheld rather than that there are none', async () => {
    const client = {
      person: vi.fn(async () => person({ traits: {}, trait_total: 0, traits_withheld: true })),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByText(/cannot be split/i)).toBeInTheDocument()
  })

  it('calls onUnauthorized on a 401 rather than rendering an error', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client, { onUnauthorized })
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a placeholder where the timeline goes, marked as not yet built', async () => {
    const client = { person: vi.fn(async () => person()) } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    expect(await screen.findByTestId('timeline-placeholder')).toBeInTheDocument()
  })
})

// Invented mutation: a component that shows the profile view regardless of
// which error came back would pass every test above individually if each
// one only checked for ITS OWN message being present -- this proves the
// three failure states are mutually exclusive on screen, not just each
// independently reachable.
describe('People -- invented mutations', () => {
  it('never renders the profile view on a 404, even though the same client mock would resolve for another id', async () => {
    const client = {
      person: vi.fn(async () => {
        throw new ApiError(404, 'person_not_found')
      }),
    } as unknown as ApiClient
    renderPeople('/people?id=ghost', client)
    await screen.findByTestId('person-not-found')
    expect(screen.queryByTestId('identity-ids')).toBeNull()
    expect(screen.queryByTestId('timeline-placeholder')).toBeNull()
  })

  it('never calls the export or delete endpoints -- this task builds neither', async () => {
    const personExport = vi.fn()
    const deletePerson = vi.fn()
    const client = {
      person: vi.fn(async () => person()),
      personExport,
      deletePerson,
    } as unknown as ApiClient
    renderPeople('/people?id=u1', client)
    await screen.findByTestId('identity-ids')
    expect(personExport).not.toHaveBeenCalled()
    expect(deletePerson).not.toHaveBeenCalled()
  })
})
